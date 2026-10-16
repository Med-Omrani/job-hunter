import 'package:flutter/material.dart';

import '../theme/app_theme.dart';

class BrandAvatar extends StatelessWidget {
  const BrandAvatar({
    super.key,
    required this.label,
    this.color,
    this.size = 46,
    this.radius = 14,
  });

  final String label;
  final Color? color;
  final double size;
  final double radius;

  String get _initials {
    final words = label.split(RegExp(r'[^A-Za-zÀ-ÿ]+')).where((w) => w.isNotEmpty).toList();
    if (words.isEmpty) return '?';
    if (words.length == 1) {
      final s = words.first;
      return s.length >= 2 ? s.substring(0, 2).toUpperCase() : s.toUpperCase();
    }
    return words.take(2).map((w) => w[0]).join().toUpperCase();
  }

  @override
  Widget build(BuildContext context) {
    final c = color ?? Brand.navy;
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(radius),
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [c, Color.lerp(c, Colors.black, 0.35)!],
        ),
      ),
      alignment: Alignment.center,
      child: Text(
        _initials,
        style: TextStyle(
          color: Colors.white,
          fontSize: size * 0.32,
          fontWeight: FontWeight.w800,
        ),
      ),
    );
  }
}

class AgentAvatar extends StatelessWidget {
  const AgentAvatar({super.key, this.size = 46, this.online = false});

  final double size;
  final bool online;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Stack(
      clipBehavior: Clip.none,
      children: [
        Container(
          width: size,
          height: size,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(size * 0.34),
            gradient: Brand.gradient(),
            boxShadow: [
              BoxShadow(
                color: Brand.navy.withValues(alpha: 0.35),
                blurRadius: 14,
                offset: const Offset(0, 6),
              ),
            ],
          ),
          alignment: Alignment.center,
          child: Icon(Icons.smart_toy_outlined, color: Colors.white, size: size * 0.5),
        ),
        Positioned(
          right: -1,
          bottom: -1,
          child: Container(
            width: size * 0.3,
            height: size * 0.3,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: scheme.surface,
              border: Border.all(color: scheme.surface, width: 2),
            ),
            child: Padding(
              padding: EdgeInsets.all(size * 0.045),
              child: DecoratedBox(
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: online ? const Color(0xFF2BB673) : Colors.grey,
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }
}