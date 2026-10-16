import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../services/db_api.dart';
import '../utils/time.dart';
import 'avatars.dart';
import 'empty_state.dart';
import 'tappable_text.dart';

/// A single chat message as parsed from the API.
class ChatMessage {
  final String key;
  final String text;
  final String sender;
  final dynamic createdAt;
  final String? replyTo;
  final String? replySender;
  final String? replyText;

  ChatMessage({
    required this.key,
    required this.text,
    required this.sender,
    required this.createdAt,
    this.replyTo,
    this.replySender,
    this.replyText,
  });

  bool get hasReply => replyTo != null;

  static List<ChatMessage> parse(List<Map<String, dynamic>> raw) {
    return raw
        .map((m) {
          return ChatMessage(
            key: (m['key'] ?? m['id'] ?? '').toString(),
            text: (m['text'] ?? '').toString(),
            sender: (m['sender'] ?? '').toString(),
            createdAt: m['createdAt'],
            replyTo: m['replyTo']?.toString(),
            replySender: m['replySender']?.toString(),
            replyText: m['replyText']?.toString(),
          );
        })
        .toList()
      ..sort((a, b) {
        final ca = timeToDate(a.createdAt).millisecondsSinceEpoch;
        final cb = timeToDate(b.createdAt).millisecondsSinceEpoch;
        final c = cb.compareTo(ca);
        return c != 0 ? c : b.key.compareTo(a.key);
      })
      ..removeWhere((m) => _isDocsConfirmation(m.text));
  }

  // Hide only legacy Firebase duplicate confirmations (phrasing the Docker
  // stack never emits). Worker ✅ announcements must stay visible.
  static bool _isDocsConfirmation(String text) {
    final t = text.toLowerCase();
    return t.contains('télécharge-les') || t.contains('documents adaptés');
  }
}

/// Header under the app bar showing the agent presence dot.
class ChatAgentHeader extends StatelessWidget implements PreferredSizeWidget {
  const ChatAgentHeader({super.key, required this.online, this.title = 'Agent'});
  final bool online;
  final String title;

  @override
  Size get preferredSize => const Size.fromHeight(30);

  @override
  Widget build(BuildContext context) {
    final c = online ? const Color(0xFF2BB673) : Colors.grey;
    return PreferredSize(
      preferredSize: const Size.fromHeight(30),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 4),
        child: Row(
          children: [
            _ChatPulseDot(color: c, active: online),
            const SizedBox(width: 7),
            Text(
              online ? '$title en ligne' : '$title hors ligne',
              style: TextStyle(fontSize: 12.5, color: c, fontWeight: FontWeight.w700),
            ),
          ],
        ),
      ),
    );
  }
}

class _ChatPulseDot extends StatefulWidget {
  const _ChatPulseDot({required this.color, required this.active});
  final Color color;
  final bool active;

  @override
  State<_ChatPulseDot> createState() => _ChatPulseDotState();
}

class _ChatPulseDotState extends State<_ChatPulseDot>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c =
      AnimationController(vsync: this, duration: const Duration(milliseconds: 900))
        ..repeat(reverse: true);

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (!widget.active) {
      return Container(
        width: 9,
        height: 9,
        decoration: BoxDecoration(shape: BoxShape.circle, color: widget.color),
      );
    }
    return FadeTransition(
      opacity: Tween(begin: 0.4, end: 1.0).animate(_c),
      child: Container(
        width: 9,
        height: 9,
        decoration: BoxDecoration(shape: BoxShape.circle, color: widget.color),
      ),
    );
  }
}

class ChatList extends StatefulWidget {
  const ChatList({super.key, required this.messages, this.onReply});
  final List<ChatMessage> messages;
  final ValueChanged<ChatMessage>? onReply;

  @override
  State<ChatList> createState() => _ChatListState();
}

class _ChatListState extends State<ChatList> {
  final _scroll = ScrollController();

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final items = <_ChatItem>[];
    DateTime? lastDay;
    for (final m in widget.messages) {
      final d = timeToDate(m.createdAt).toLocal();
      final day = DateTime(d.year, d.month, d.day);
      if (lastDay == null || day != lastDay) {
        items.add(_ChatItem.sep(_sepLabel(d), day));
        lastDay = day;
      }
      items.add(_ChatItem.msg(m, widget.onReply));
    }
    return ListView.builder(
      controller: _scroll,
      reverse: true,
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
      itemCount: items.length,
      itemBuilder: (context, i) => items[i].build(context),
    );
  }

  String _sepLabel(DateTime d) {
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    final day = DateTime(d.year, d.month, d.day);
    final diff = today.difference(day).inDays;
    if (diff == 0) return "Aujourd'hui";
    if (diff == 1) return 'Hier';
    return fmtFull(d);
  }
}

class _ChatItem {
  final ChatMessage? msg;
  final String? sepLabel;
  final DateTime? sepDate;
  final ValueChanged<ChatMessage>? onReply;
  double _dragDx = 0;
  _ChatItem.msg(this.msg, [this.onReply]) : sepLabel = null, sepDate = null;
  _ChatItem.sep(this.sepLabel, this.sepDate) : msg = null, onReply = null;

  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    if (msg == null) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 10),
        child: Center(
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 5),
            decoration: BoxDecoration(
              color: scheme.surfaceContainerHigh,
              borderRadius: BorderRadius.circular(999),
            ),
            child: Text(
              sepLabel!,
              style: TextStyle(fontSize: 11, color: scheme.onSurfaceVariant, fontWeight: FontWeight.w600),
            ),
          ),
        ),
      );
    }

    final m = msg!;
    final mine = m.sender == 'user';
    final row = Row(
      crossAxisAlignment: CrossAxisAlignment.end,
      mainAxisSize: MainAxisSize.min,
      children: [
        if (!mine) ...[
          const SizedBox(height: 22, child: AgentAvatar(size: 22, online: false)),
          const SizedBox(width: 6),
        ],
        Flexible(
          child: ConstrainedBox(
            constraints: BoxConstraints(
              maxWidth: MediaQuery.sizeOf(context).width * 0.8,
            ),
            child: Padding(
              padding: EdgeInsets.only(left: mine ? 48 : 0, right: mine ? 0 : 48),
              child: Container(
                padding: const EdgeInsets.fromLTRB(13, 9, 10, 6),
                decoration: BoxDecoration(
                  color: mine ? scheme.primaryContainer : scheme.surfaceContainerHigh,
                  borderRadius: BorderRadius.only(
                    topLeft: const Radius.circular(16),
                    topRight: const Radius.circular(16),
                    bottomLeft: Radius.circular(mine ? 16 : 5),
                    bottomRight: Radius.circular(mine ? 5 : 16),
                  ),
                ),
                child: Column(
                  crossAxisAlignment:
                      mine ? CrossAxisAlignment.end : CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    if (m.hasReply) ...[
                      _ReplyQuote(
                        sender: m.replySender ?? 'user',
                        text: m.replyText ?? '',
                        mine: mine,
                      ),
                      const SizedBox(height: 7),
                    ],
                    TappableText(
                      text: m.text,
                      style: TextStyle(color: scheme.onSurface, fontSize: 14.5, height: 1.35),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      fmtTime(m.createdAt),
                      style: TextStyle(fontSize: 10, color: scheme.onSurfaceVariant.withValues(alpha: 0.7)),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ],
    );

    return GestureDetector(
      onLongPress: () => _copy(context, m),
      onHorizontalDragUpdate: (d) => _dragDx += d.delta.dx,
      onHorizontalDragEnd: (detail) {
        final swipe = _dragDx > 60 || (detail.primaryVelocity ?? 0) > 250;
        _dragDx = 0;
        if (swipe && onReply != null) {
          HapticFeedback.mediumImpact();
          onReply!(m);
        }
      },
      child: Padding(
        padding: EdgeInsets.only(bottom: m.sender == 'user' ? 5 : 10),
        child: Align(
          alignment: mine ? Alignment.centerRight : Alignment.centerLeft,
          child: row,
        ),
      ),
    );
  }

  Future<void> _copy(BuildContext context, ChatMessage m) async {
    await Clipboard.setData(ClipboardData(text: m.text));
    if (!context.mounted) return;
    ScaffoldMessenger.of(context)
        .showSnackBar(const SnackBar(content: Text('Message copié'), duration: Duration(seconds: 1)));
  }
}

/// Quoted original message shown inside a bubble (Messenger/WhatsApp style).
class _ReplyQuote extends StatelessWidget {
  const _ReplyQuote({required this.sender, required this.text, required this.mine});
  final String sender;
  final String text;
  final bool mine;

  String get _who => sender == 'user' ? 'toi' : (sender == 'agent' ? 'l\'agent' : sender);

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final accent = scheme.primary;
    return Align(
      alignment: mine ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        constraints: BoxConstraints(maxWidth: MediaQuery.sizeOf(context).width * 0.6),
        padding: const EdgeInsets.fromLTRB(10, 5, 10, 5),
        decoration: BoxDecoration(
          color: accent.withValues(alpha: 0.10),
          borderRadius: BorderRadius.circular(9),
          border: Border(left: BorderSide(color: accent, width: 3)),
        ),
        child: Column(
          crossAxisAlignment: mine ? CrossAxisAlignment.end : CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(Icons.reply_rounded, size: 13, color: accent),
                const SizedBox(width: 4),
                Text(
                  'Répondre à $_who',
                  style: TextStyle(
                    fontSize: 11,
                    fontWeight: FontWeight.w700,
                    color: accent,
                  ),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ],
            ),
            if (text.isNotEmpty) ...[
              const SizedBox(height: 2),
              Text(
                text,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(fontSize: 12, height: 1.3, color: scheme.onSurfaceVariant),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class ChatQuickReplies extends StatelessWidget {
  const ChatQuickReplies({super.key, required this.onSent, this.channel = 'main'});
  final Future<void> Function() onSent;
  final String channel;

  Future<void> _askOfferLink(BuildContext context) async {
    final controller = TextEditingController();
    final link = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Coller un lien d\'offre'),
        content: TextField(
          controller: controller,
          autofocus: true,
          keyboardType: TextInputType.url,
          textInputAction: TextInputAction.done,
          onSubmitted: (v) => Navigator.of(ctx).pop(v.trim()),
          decoration: const InputDecoration(
            hintText: 'https://…',
            labelText: 'Lien de l\'offre',
            border: OutlineInputBorder(),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(),
            child: const Text('Annuler'),
          ),
          FilledButton(
            onPressed: () =>
                Navigator.of(ctx).pop(controller.text.trim()),
            child: const Text('Envoyer'),
          ),
        ],
      ),
    );
    if (link == null || link.isEmpty) return;
    await DbApi.sendChat(link, 'user', channel: channel);
    await onSent();
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return SafeArea(
      top: false,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(12, 6, 12, 0),
        child: Row(
          children: [
            Icon(Icons.bolt, size: 16, color: scheme.secondary),
            const SizedBox(width: 4),
            Expanded(
              child: SingleChildScrollView(
                scrollDirection: Axis.horizontal,
                child: Row(
                  children: [
                    ActionChip(
                      avatar: const Icon(Icons.add_link, size: 16),
                      label: const Text('Lien d\'offre',
                          style: TextStyle(
                              fontSize: 12.5, fontWeight: FontWeight.w600)),
                      onPressed: () => _askOfferLink(context),
                      visualDensity: VisualDensity.compact,
                    ),
                    const SizedBox(width: 8),
                    _QuickChip(label: 'Voir les offres', text: 'liens', onSent: onSent, channel: channel),
                    const SizedBox(width: 8),
                    _QuickChip(label: 'CV & lettres', text: 'pdfs', onSent: onSent, channel: channel),
                    const SizedBox(width: 8),
                    _QuickChip(
                        label: 'État des candidatures', text: 'statut', onSent: onSent, channel: channel),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _QuickChip extends StatelessWidget {
  const _QuickChip(
      {required this.label, required this.text, required this.onSent, required this.channel});
  final String label;
  final String text;
  final Future<void> Function() onSent;
  final String channel;

  @override
  Widget build(BuildContext context) {
    return ActionChip(
      label: Text(label, style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600)),
      onPressed: () async {
        await DbApi.sendChat(text, 'user', channel: channel);
        await onSent();
      },
      visualDensity: VisualDensity.compact,
    );
  }
}

class ChatTypingIndicator extends StatefulWidget {
  const ChatTypingIndicator({super.key, required this.working});
  final bool working;

  @override
  State<ChatTypingIndicator> createState() => _ChatTypingIndicatorState();
}

class _ChatTypingIndicatorState extends State<ChatTypingIndicator>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c =
      AnimationController(vsync: this, duration: const Duration(milliseconds: 1100))
        ..repeat();

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (!widget.working) return const SizedBox.shrink();
    return AnimatedBuilder(
      animation: _c,
      builder: (context, _) {
        final t = _c.value;
        return Align(
          alignment: Alignment.centerLeft,
          child: Container(
            margin: const EdgeInsets.fromLTRB(12, 4, 12, 0),
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
            decoration: BoxDecoration(
              color: Theme.of(context).colorScheme.surfaceContainerHigh,
              borderRadius: BorderRadius.circular(16),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: List.generate(3, (i) {
                final phase = ((t + i / 3) % 1.0);
                final dy = (phase < 0.5 ? phase : 1 - phase) * 6.0;
                return Transform.translate(
                  offset: Offset(0, -dy),
                  child: Container(
                    width: 7,
                    height: 7,
                    margin: const EdgeInsets.symmetric(horizontal: 3),
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      color: Theme.of(context).colorScheme.primary,
                    ),
                  ),
                );
              }),
            ),
          ),
        );
      },
    );
  }
}

class ChatComposer extends StatefulWidget {
  const ChatComposer({super.key, required this.onSent, this.channel = 'main', this.replyTo, this.onCancelReply});
  final Future<void> Function() onSent;
  final String channel;
  final ChatMessage? replyTo;
  final VoidCallback? onCancelReply;

  @override
  State<ChatComposer> createState() => _ChatComposerState();
}

class _ChatComposerState extends State<ChatComposer> {
  final _controller = TextEditingController();
  final _focus = FocusNode();

  Future<void> _send() async {
    final text = _controller.text.trim();
    if (text.isEmpty) return;
    _controller.clear();
    final mt = widget.replyTo;
    widget.onCancelReply?.call();
    await DbApi.sendChat(text, 'user', channel: widget.channel, replyTo: mt?.key);
    await widget.onSent();
    _focus.requestFocus();
  }

  @override
  void dispose() {
    _controller.dispose();
    _focus.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final reply = widget.replyTo;
    return SafeArea(
      top: false,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(10, 4, 10, 8),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (reply != null) ...[
              Container(
                margin: const EdgeInsets.only(bottom: 6),
                padding: const EdgeInsets.fromLTRB(10, 7, 6, 7),
                decoration: BoxDecoration(
                  color: scheme.surfaceContainerHigh,
                  borderRadius: BorderRadius.circular(14),
                  border: Border(left: BorderSide(color: scheme.primary, width: 3)),
                ),
                child: Row(
                  children: [
                    Icon(Icons.reply_rounded, size: 17, color: scheme.primary),
                    const SizedBox(width: 7),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Text(
                            'Répondre à ${reply.sender == 'user' ? 'toi' : 'l\'agent'}',
                            style: TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: scheme.primary),
                          ),
                          if ((reply.replyText ?? '').isNotEmpty) ...[
                            const SizedBox(height: 1),
                            Text(
                              reply.replyText!,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(fontSize: 12.5, color: scheme.onSurfaceVariant),
                            ),
                          ],
                        ],
                      ),
                    ),
                    IconButton(
                      icon: const Icon(Icons.close, size: 18),
                      visualDensity: VisualDensity.compact,
                      onPressed: widget.onCancelReply,
                      tooltip: 'Annuler la réponse',
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 2),
            ],
            Row(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Expanded(
                  child: TextField(
                    controller: _controller,
                    focusNode: _focus,
                    minLines: 1,
                    maxLines: 4,
                    textCapitalization: TextCapitalization.sentences,
                    decoration: InputDecoration(
                      hintText: 'Écris ton message…',
                      filled: true,
                      fillColor: scheme.surfaceContainerHigh,
                      border: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(22),
                        borderSide: BorderSide.none,
                      ),
                      enabledBorder: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(22),
                        borderSide: BorderSide.none,
                      ),
                      contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                    ),
                    textInputAction: TextInputAction.send,
                    onSubmitted: (_) => _send(),
                  ),
                ),
                const SizedBox(width: 8),
                IconButton.filled(
                  onPressed: _send,
                  icon: const Icon(Icons.send_rounded),
                  style: IconButton.styleFrom(
                    backgroundColor: Theme.of(context).colorScheme.primary,
                    foregroundColor: Theme.of(context).colorScheme.onPrimary,
                    minimumSize: const Size(46, 46),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

/// Convenience empty chat body used by both screens when a channel has no messages.
class ChatEmptyBody extends StatelessWidget {
  const ChatEmptyBody({
    super.key,
    required this.onSent,
    this.channel = 'main',
    this.icon = Icons.auto_awesome,
    this.title = 'Ton agent t\'attend',
    this.subtitle = 'Demande les liens, les PDFs ou l\'état des candidatures, ou colle un lien d\'offre pour l\'adapter.',
  });

  final Future<void> Function() onSent;
  final String channel;
  final IconData icon;
  final String title;
  final String subtitle;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Expanded(
          child: EmptyState(icon: icon, title: title, subtitle: subtitle),
        ),
        ChatQuickReplies(onSent: onSent, channel: channel),
        ChatComposer(onSent: onSent, channel: channel),
      ],
    );
  }
}