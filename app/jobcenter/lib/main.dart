import 'dart:async';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/material.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';

import 'app_state.dart';
import 'screens/home_shell.dart';
import 'services/api_host.dart';
import 'services/db_api.dart';
import 'theme/app_theme.dart';

final FlutterLocalNotificationsPlugin _notif = FlutterLocalNotificationsPlugin();

/// Whether a new agent chat message raises a LOCAL notification on its own.
/// Off (2026-09-30): the user wants to be pinged for new offers only, and this
/// ticker was popping on every `✅` ack / `📝` progress note / `❓` question
/// while the app process was alive -- independently of the FCM push gate in
/// app/daemon/push.js (PUSH_CHAT_MODE). Set to true together with
/// PUSH_CHAT_MODE=action_only, never on its own, or the chat notifies again
/// from one side only. Offers and finished documents are unaffected.
const bool kChatLocalNotify = false;

// FCM push (project jobdocker): killed-app delivery. Foreground/ticker
// notifications below stay as the fast path when the app process lives.
String? _lastOfferSeen;
String? _lastAgentMsgSeen;
final Set<String> _seenAgentIds = {};
final Set<String> _knownDoneTasks = {};
Timer? _watchTimer;

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  try {
    await ApiHost.getToken();
  } catch (_) {}
  try {
    await Firebase.initializeApp();
  } catch (_) {}
  await _initNotifications();
  await _initFcm();
  runApp(const JobCenterApp());
  _startWatch();
}

@pragma('vm:entry-point')
Future<void> _bgHandler(RemoteMessage message) async {
  // push.js sends DATA-ONLY payloads (no `notification` block -- title/body ride
  // inside `data`), so Android does NOT raise a tray notification for them: a
  // backgrounded or killed app is handed the data here and, if this handler does
  // nothing, the payload is silently dropped. That is why offers never notified
  // all day while events-push.log showed `sent:1 failed:0` -- FCM accepting a
  // message is not the same as the device displaying it. The tray entry has to
  // be built in this isolate.
  //
  // `main()` and `_initNotifications()` do NOT run here, so Firebase and the
  // notifications plugin must be (re)initialized, and the top-level `_notif`
  // cannot be reused: it was never initialized on this isolate.
  try {
    await Firebase.initializeApp();
  } catch (_) {}
  try {
    final bgNotif = FlutterLocalNotificationsPlugin();
    await bgNotif.initialize(const InitializationSettings(
      android: AndroidInitializationSettings('@mipmap/ic_launcher'),
      iOS: DarwinInitializationSettings(),
    ));
    await _showFromFcm(message, bgNotif);
  } catch (_) {}
}

Future<void> _initFcm() async {
  try {
    final messaging = FirebaseMessaging.instance;
    await messaging.requestPermission(alert: true, badge: true, sound: true);
    FirebaseMessaging.onBackgroundMessage(_bgHandler);
    // Server pushes are data-only (push.js:107 sends no `notification` block, so
    // a foregrounded app does not get a system tray copy on top of this one).
    // Title/body therefore travel in `data`; the `notification` fallback only
    // matters for a legacy payload.
    FirebaseMessaging.onMessage.listen((m) => _showFromFcm(m, _notif));
    FirebaseMessaging.onMessageOpenedApp.listen(_openFromFcm);
    final token = await messaging.getToken();
    if (token != null) {
      for (var attempt = 0; attempt < 3; attempt++) {
        try {
          await DbApi.saveFcmToken(token);
          break;
        } catch (_) {
          await Future<void>.delayed(const Duration(seconds: 5));
        }
      }
    }
    messaging.onTokenRefresh.listen((t) {
      DbApi.saveFcmToken(t);
    });
    final initial = await messaging.getInitialMessage();
    if (initial != null) _openFromFcm(initial);
  } catch (_) {}
}

/// Payload carried by every offer-related notification.
  ///
  /// Previously this was the bare tag, so a tap could only ever switch tabs --
  /// the offer itself was unreachable from the notification. The offer id is
  /// appended after a colon so the tag parsing below stays a prefix test, and so
  /// a tag-only payload from an older build still degrades to plain tab
  /// switching instead of breaking.
  String _offerPayload(String tag, String? offerId) {
    final id = (offerId ?? '').trim();
    return id.isEmpty ? tag : '$tag:$id';
  }

  /// Pulls the offer id back out of a payload, or null when the payload names no
  /// offer. Tolerates the raw id as well as `tag:id`, since the FCM path carries
  /// the two separately.
  String? _offerIdFrom(Object? payload) {
    final raw = (payload ?? '').toString().trim();
    if (raw.isEmpty) return null;
    final cut = raw.indexOf(':');
    final tail = (cut == -1 ? raw : raw.substring(cut + 1)).trim();
    return tail.isEmpty ? null : tail;
  }

void _openFromFcm(RemoteMessage message) {
  final tag = (message.data['tag'] ?? '').toString();
  if (tag == 'offer' || tag == 'new_offer') {
    AppState.tabIndex.value = 1;
    final id = _offerIdFrom(message.data['offerId'] ?? message.data['tag']);
    if (id != null) AppState.openOfferId.value = id;
  } else if (tag.startsWith('apply') || tag.startsWith('task')) {
    AppState.tabIndex.value = 3;
  } else {
    AppState.tabIndex.value = 0;
  }
}

Future<void> _initNotifications() async {
  await _notif.initialize(
    const InitializationSettings(
      android: AndroidInitializationSettings('@mipmap/ic_launcher'),
      iOS: DarwinInitializationSettings(),
    ),
    onDidReceiveNotificationResponse: (r) => _openFromPayload(r.payload ?? ''),
  );
}

void _startWatch() {
  Future<void> tick() async {
    try {
      final offers = await DbApi.offers(limit: 5);
      if (offers.isNotEmpty) {
        final newest = (offers.first['updatedAt'] ?? offers.first['updated_at'] ?? '').toString();
        if (_lastOfferSeen == null) {
          _lastOfferSeen = newest;
        } else if (newest.compareTo(_lastOfferSeen!) > 0) {
          _lastOfferSeen = newest;
          final o = offers.first;
          // The id is right here, so the tray entry can name the offer and the
          // tap can open it directly instead of dropping the user on the tab.
          await _showLocalNotification(
            'Nouvelle offre',
            '${o['title'] ?? 'Offre'} — ${(o['company'] ?? '').toString()}',
            _offerPayload('new_offer', (o['id'] ?? '').toString()),
          );
        }
      }
    } catch (_) {}
    if (kChatLocalNotify) {
      try {
        // New agent chat messages (preview/needs_info/results) -> notify once.
        final chat = await DbApi.chatMessages(limit: 8);
        for (var i = chat.length - 1; i >= 0; i--) {
          final m = chat[i];
          if (m['sender'] != 'agent') continue;
          final id = (m['id'] ?? m['key'] ?? '').toString();
          final text = (m['text'] ?? '').toString();
          if (id.isEmpty || _seenAgentIds.contains(id)) continue;
          _seenAgentIds.add(id);
          if (_lastAgentMsgSeen == null) {
            _lastAgentMsgSeen = id;
            continue; // first run: mark position silently
          }
          _lastAgentMsgSeen = id;
          final urgent =
              text.startsWith('❓') || text.startsWith('❌') || text.startsWith('📝');
          await _showLocalNotification(
            urgent ? 'Action requise — JobCenter' : 'Message de ton agent',
            text.length > 180 ? '${text.substring(0, 180)}…' : text,
            'agent_msg',
          );
          break; // one notification per tick max
        }
        while (_seenAgentIds.length > 100) {
          _seenAgentIds.remove(_seenAgentIds.first);
        }
      } catch (_) {}
    }
    try {
      final done = await DbApi.tasks(status: 'done', limit: 5);
      for (final t in done) {
        final id = (t['id'] ?? '').toString();
        if (id.isEmpty || _knownDoneTasks.contains(id)) continue;
        _knownDoneTasks.add(id);
        if (_knownDoneTasks.length > 1) {
          await _showLocalNotification(
            'Documents prêts',
            (t['result'] ?? 'CV + lettre adaptés').toString(),
            'task_done',
          );
        }
      }
      while (_knownDoneTasks.length > 50) {
        _knownDoneTasks.remove(_knownDoneTasks.first);
      }
    } catch (_) {}
  }

  tick();
  _watchTimer?.cancel();
  _watchTimer = Timer.periodic(const Duration(seconds: 20), (_) => tick());
}

// One channel for every local notification, foreground or background, so the two
// delivery paths cannot drift apart.
const NotificationDetails _notifDetails = NotificationDetails(
  android: AndroidNotificationDetails(
    'offres',
    'Nouvelles offres',
    channelDescription: 'Notifications des nouvelles offres d emploi',
    importance: Importance.high,
    priority: Priority.high,
  ),
);

// Android keeps one tray entry per notification id, so a single hardcoded id (it
// used to be 1) means every new notification REPLACES the previous one -- an offer
// push silently wiped a finished-documents push. One stable id per tag instead.
int _notifId(String tag) {
  switch (tag) {
    case 'offer':
    case 'new_offer':
      return 1;
    case 'task_done':
      return 2;
    case 'agent_msg':
      return 3;
    default:
      return 4;
  }
}

/// Builds the tray notification for an FCM message. Shared by the foreground
/// listener and the background isolate handler so both read the payload the
/// same way; `plugin` is passed in because the background isolate needs its own
/// initialized instance.
Future<void> _showFromFcm(RemoteMessage m, FlutterLocalNotificationsPlugin plugin) async {
  final title = (m.data['title'] ?? m.notification?.title ?? 'JobCenter').toString();
  final body = (m.data['body'] ?? m.notification?.body ?? 'Nouveau message').toString();
  final tag = (m.data['tag'] ?? 'agent_msg').toString();
  // The id rides in the tray payload so the TAP can open the offer, not just the
  // tab. An FCM push from before this change has no offerId and still works.
  final payload = _offerPayload(tag, (m.data['offerId'] ?? '').toString());
  await plugin.show(_notifId(tag), title, body, _notifDetails, payload: payload);
}

Future<void> _showLocalNotification(String title, String body, String payload) async {
  await _notif.show(_notifId(payload.split(':').first), title, body, _notifDetails, payload: payload);
}

void _openFromPayload(String payload) {
  final tag = payload.split(':').first;
  if (tag == 'agent_msg') {
    AppState.tabIndex.value = 0;
  } else if (tag.contains('new_offer') || tag.contains('offer')) {
    AppState.tabIndex.value = 1;
    final id = _offerIdFrom(payload);
    if (id != null) AppState.openOfferId.value = id;
  } else if (tag.contains('task') || tag.contains('doc')) {
    AppState.tabIndex.value = 3;
  }
}

class JobCenterApp extends StatelessWidget {
  const JobCenterApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'JobCenter',
      theme: AppTheme.light(),
      darkTheme: AppTheme.dark(),
      themeMode: ThemeMode.system,
      home: const HomeShell(),
    );
  }
}
