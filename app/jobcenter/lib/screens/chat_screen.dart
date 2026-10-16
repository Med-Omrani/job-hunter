import 'dart:async';

import 'package:flutter/material.dart';

import '../services/db_api.dart';
import '../widgets/chat_kit.dart';
import '../widgets/skeleton.dart';
import 'hotline_screen.dart';

class ChatScreen extends StatefulWidget {
  const ChatScreen({super.key});

  @override
  State<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends State<ChatScreen> {
  static const _channel = 'main';
  List<ChatMessage> _msgs = [];
  ChatMessage? _replyTo;
  bool _loaded = false;
  bool _online = false;
  bool _working = false;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _reload();
    _timer = Timer.periodic(const Duration(seconds: 5), (_) => _reload());
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  Future<void> _reload() async {
    final status = await _fetchStatus();
    var msgs = _msgs;
    var loaded = _loaded;
    try {
      msgs = ChatMessage.parse(await DbApi.chatMessages(limit: 200, channel: _channel));
      loaded = true;
    } catch (_) {}
    if (!mounted) return;
    setState(() {
      _msgs = msgs;
      _loaded = loaded;
      if (status != null) {
        _online = _isOnline(status);
        _working = _isWorking(status);
      }
      if (_replyTo != null && !_msgs.any((m) => m.key == _replyTo!.key)) _replyTo = null;
    });
  }

  Future<Map<String, dynamic>?> _fetchStatus() async {
    try {
      return await DbApi.agentStatus();
    } catch (_) {
      return null;
    }
  }

  void _setReply(ChatMessage m) {
    if (m.key == _replyTo?.key) return;
    setState(() => _replyTo = m);
  }

  static const int _presenceWindowMs = 60000;

  bool _fresh(dynamic at) {
    if (at is! num) return false;
    return DateTime.now().millisecondsSinceEpoch - at.toInt() <= _presenceWindowMs;
  }

  bool _isOnline(Map<String, dynamic> v) {
    if (v['online'] == true) return true;
    return _fresh(v['at']);
  }

  bool _isWorking(Map<String, dynamic> v) {
    if (v['working'] != true) return false;
    return _fresh(v['workingAt']);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Chat'),
        actions: [
          IconButton(
            tooltip: 'Hotline',
            icon: const Icon(Icons.support_agent),
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute(builder: (_) => const HotlineScreen()),
            ),
          ),
        ],
        bottom: ChatAgentHeader(online: _online),
      ),
      body: !_loaded
          ? const SkeletonList(count: 4)
          : _msgs.isEmpty
              ? ChatEmptyBody(onSent: _reload, channel: _channel)
              : Column(
                  children: [
                    Expanded(child: ChatList(messages: _msgs, onReply: _setReply)),
                    ChatQuickReplies(onSent: _reload, channel: _channel),
                    ChatTypingIndicator(working: _working),
                    ChatComposer(
                      onSent: _reload,
                      channel: _channel,
                      replyTo: _replyTo,
                      onCancelReply: () => setState(() => _replyTo = null),
                    ),
                  ],
                ),
    );
  }
}