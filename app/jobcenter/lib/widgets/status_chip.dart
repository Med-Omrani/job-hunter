import 'package:flutter/material.dart';

/// The four pipeline stages, in the order a job moves through them.
const offerStatuses = <String>['new', 'to_apply', 'applied', 'rejected'];

/// Single source of truth for how a status looks and reads.
///
/// This used to be duplicated in offer_card.dart (colour + label) and again in
/// the old board_tab.dart (colour + label + icon). One table now, so a new
/// stage cannot drift between the card, the chip and the Vu tab.
class OfferStatusStyle {
  final Color color;
  final String label;
  final IconData icon;
  const OfferStatusStyle(this.color, this.label, this.icon);
}

const offerStatusStyles = <String, OfferStatusStyle>{
  'new': OfferStatusStyle(Color(0xFF1B6EF3), 'Nouvelle', Icons.fiber_new),
  'to_apply': OfferStatusStyle(Color(0xFFB26A00), 'À postuler', Icons.outgoing_mail),
  'applied': OfferStatusStyle(Color(0xFF2BB673), 'Postulée', Icons.check_circle_outline),
  'rejected': OfferStatusStyle(Color(0xFF8A8F98), 'Refusée', Icons.cancel_outlined),
};

OfferStatusStyle offerStatusStyle(String status) =>
    offerStatusStyles[status] ?? offerStatusStyles['new']!;

Color offerStatusColor(String status) => offerStatusStyle(status).color;

String offerStatusLabel(String status) => offerStatusStyle(status).label;

IconData offerStatusIcon(String status) => offerStatusStyle(status).icon;

class StatusChip extends StatelessWidget {
  const StatusChip({
    super.key,
    required this.label,
    required this.color,
    this.icon,
    this.onTap,
  });

  final String label;
  final Color color;
  final IconData? icon;

  /// When set the chip becomes a tap target, used to change the status from a
  /// card (replaces the old drag-and-drop board).
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final body = Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.13),
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: color.withValues(alpha: 0.35), width: 0.8),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (icon != null) ...[
            Icon(icon, size: 13, color: color),
            const SizedBox(width: 4),
          ],
          Text(
            label,
            style: TextStyle(
              color: color,
              fontSize: 11.5,
              fontWeight: FontWeight.w700,
            ),
          ),
          if (onTap != null) ...[
            const SizedBox(width: 3),
            Icon(Icons.expand_more, size: 14, color: color),
          ],
        ],
      ),
    );
    if (onTap == null) return body;
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(999),
      child: body,
    );
  }
}

class MatchChip extends StatelessWidget {
  const MatchChip({super.key});

  @override
  Widget build(BuildContext context) {
    final c = Theme.of(context).colorScheme.secondary;
    return StatusChip(label: 'Correspond à ton profil', color: c, icon: Icons.check);
  }
}