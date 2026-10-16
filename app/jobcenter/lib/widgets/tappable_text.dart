import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

class TappableText extends StatelessWidget {
  const TappableText({
    super.key,
    required this.text,
    this.style,
    this.linkColor,
    this.maxLines,
    this.overflow,
    this.onOpen,
  });

  final String text;
  final TextStyle? style;
  final Color? linkColor;
  final int? maxLines;
  final TextOverflow? overflow;
  final Future<void> Function(String url)? onOpen;

  static final _urlRe = RegExp(
    r'((https?://|www\.)[^\s<>]+)',
    caseSensitive: false,
  );

  static Future<void> _openDefault(String url) async {
    var u = url;
    if (u.startsWith('www.')) u = 'https://$u';
    final uri = Uri.tryParse(u);
    if (uri == null) return;
    await launchUrl(uri, mode: LaunchMode.externalApplication);
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final link = linkColor ?? scheme.primary;
    final base = style ?? DefaultTextStyle.of(context).style;
    final spans = <TextSpan>[];
    var start = 0;
    for (final m in _urlRe.allMatches(text)) {
      if (m.start > start) {
        spans.add(TextSpan(text: text.substring(start, m.start)));
      }
      final raw = m.group(1)!;
      final target = raw.startsWith('www.') ? 'https://$raw' : raw;
      spans.add(
        TextSpan(
          text: raw,
          style: base.copyWith(color: link, fontWeight: FontWeight.w700),
          recognizer: TapGestureRecognizer()
            ..onTap = () {
              final open = onOpen ?? _openDefault;
              open(target);
            },
        ),
      );
      start = m.end;
    }
    if (start < text.length) {
      spans.add(TextSpan(text: text.substring(start)));
    }
    return Text.rich(
      TextSpan(style: base, children: spans),
      maxLines: maxLines,
      overflow: overflow,
    );
  }
}