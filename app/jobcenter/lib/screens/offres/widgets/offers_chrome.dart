import 'package:flutter/material.dart';

import '../../../services/db_api.dart';
import '../../../theme/app_theme.dart';

/// Dashboard header: counts by status + relaunch-search button.
class OffersHero extends StatelessWidget {
  const OffersHero({
    super.key,
    required this.facets,
    required this.total,
    required this.relaunching,
    required this.onRelaunch,
  });

  final OfferFacets facets;
  final int total;
  final bool relaunching;
  final VoidCallback onRelaunch;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.fromLTRB(16, 8, 16, 4),
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        gradient: Brand.gradient(),
        borderRadius: BorderRadius.circular(AppTheme.radius),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text('Tableau de bord',
                        style: TextStyle(
                            color: Colors.white,
                            fontSize: 20,
                            fontWeight: FontWeight.w800)),
                    const SizedBox(height: 3),
                    Text('Offres relevées en temps réel par ton agent',
                        style: TextStyle(
                            color: Colors.white.withValues(alpha: 0.8),
                            fontSize: 12.5)),
                  ],
                ),
              ),
              Container(
                padding: const EdgeInsets.all(9),
                decoration: BoxDecoration(
                  color: Colors.white.withValues(alpha: 0.14),
                  shape: BoxShape.circle,
                ),
                child:
                    const Icon(Icons.bolt_rounded, color: Colors.white, size: 22),
              ),
            ],
          ),
          const SizedBox(height: 14),
          Row(
            children: [
              _statPill(Colors.white, Colors.white, '$total', 'Offres'),
              const SizedBox(width: 8),
              _statPill(Colors.white.withValues(alpha: 0.14),
                  Colors.white.withValues(alpha: 0.9), '${facets.sources.length}',
                  'Sources'),
              const SizedBox(width: 8),
              _statPill(Colors.white.withValues(alpha: 0.14),
                  Colors.white.withValues(alpha: 0.9), '${facets.countries.length}',
                  'Pays'),
            ],
          ),
          const SizedBox(height: 14),
          Align(
            alignment: Alignment.centerLeft,
            child: relaunching
                ? const Padding(
                    padding: EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                    child: SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(
                          strokeWidth: 2.2, color: Colors.white),
                    ),
                  )
                : FilledButton.icon(
                    onPressed: onRelaunch,
                    style: FilledButton.styleFrom(
                      backgroundColor: Colors.white,
                      foregroundColor: const Color(0xFF1B6EF3),
                    ),
                    icon: const Icon(Icons.refresh_rounded, size: 18),
                    label: const Text('Relancer la recherche',
                        style: TextStyle(fontWeight: FontWeight.w800)),
                  ),
          ),
        ],
      ),
    );
  }

  Widget _statPill(Color bg, Color fg, String value, String label) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(12)),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(value,
              style: TextStyle(
                  color: fg, fontSize: 15, fontWeight: FontWeight.w800)),
          const SizedBox(width: 6),
          Text(label,
              style:
                  TextStyle(color: fg, fontSize: 11.5, fontWeight: FontWeight.w600)),
        ],
      ),
    );
  }
}

/// Tab selector. Four tabs instead of five: 'Entreprises' and 'Pays' are both
/// group-by views and are now merged into a single 'Groupes' tab.
class OffersTabBar extends StatelessWidget {
  const OffersTabBar({super.key, required this.index, required this.onChanged});

  final int index;
  final ValueChanged<int> onChanged;

  static const labels = ['Dernières', 'Toutes', 'Groupes', 'Vu'];

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.all(4),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerHigh,
        borderRadius: BorderRadius.circular(14),
      ),
      child: Row(
        children: [
          for (var i = 0; i < labels.length; i++)
            Expanded(
              child: GestureDetector(
                onTap: () => onChanged(i),
                behavior: HitTestBehavior.opaque,
                child: AnimatedContainer(
                  duration: const Duration(milliseconds: 200),
                  curve: Curves.easeOut,
                  padding: const EdgeInsets.symmetric(vertical: 9),
                  decoration: BoxDecoration(
                    color: i == index ? scheme.primary : Colors.transparent,
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: Text(
                    labels[i],
                    textAlign: TextAlign.center,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 12.5,
                      fontWeight: FontWeight.w800,
                      color: i == index ? scheme.onPrimary : scheme.onSurfaceVariant,
                    ),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}
