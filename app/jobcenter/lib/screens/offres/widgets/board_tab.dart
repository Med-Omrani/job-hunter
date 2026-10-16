import 'package:flutter/material.dart';

import '../../../utils/company.dart';
import '../../../utils/time.dart';
import '../../../widgets/offer_card.dart';
import '../../../widgets/skeleton.dart';

/// "Vu" tab: a memory log of the offers the user actually opened.
///
/// Replaces the old drag-and-drop kanban. The board was unusable on a phone:
/// four columns of 0.82x screen width meant one visible column at a time, and
/// LongPressDraggable inside a horizontal scroll view had no auto-scroll on
/// the drop target, so moving a card meant release, scroll, re-grab.
///
/// This view is one vertical scroll. Status changes go through a tap on the
/// card's status chip, which is far more reliable with one thumb.
class SeenTab extends StatefulWidget {
  const SeenTab({
    super.key,
    required this.offers,
    required this.onOpen,
    required this.onApply,
    required this.onReject,
    required this.onTailor,
    required this.onSetStatus,
    required this.tailoring,
    required this.onRefresh,
  });

  final List<Map<String, dynamic>> offers;
  final void Function(Map<String, dynamic> o) onOpen;
  final void Function(String id) onApply;
  final void Function(String id) onReject;
  final void Function(Map<String, dynamic> o) onTailor;
  final void Function(String id, String status) onSetStatus;
  final Set<String> tailoring;
  final Future<void> Function() onRefresh;

  @override
  State<SeenTab> createState() => _SeenTabState();
}

class _SeenTabState extends State<SeenTab> {
  /// Collapsed section headers, by status. Pipeline columns start expanded so
  /// the shape of the pipeline is visible without any interaction.
  final Set<String> _collapsed = <String>{};

  @override
  Widget build(BuildContext context) {
    final all = widget.offers;

    if (all.isEmpty) {
      return RefreshIndicator(
        onRefresh: widget.onRefresh,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 40, 16, 100),
          children: [
            const Icon(Icons.visibility_outlined, size: 44, color: Color(0xFFB9BEC7)),
            const SizedBox(height: 14),
            const Text(
              'Aucune offre vue pour l\'instant',
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 15, fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 6),
            const Text(
              'Ouvre une offre et elle apparaîtra ici, pour que tu '
              'puisses te rappeler ce que tu as déjà vu.',
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 12.5, height: 1.4),
            ),
          ],
        ),
      );
    }

    // Group by status, keeping the canonical pipeline order. Offers whose
    // status is "new" are grouped last: having opened one but not acted on it
    // is the "seen, not decided yet" bucket.
    final groups = <String, List<Map<String, dynamic>>>{};
    for (final s in offerStatuses) {
      groups[s] = <Map<String, dynamic>>[];
    }
    for (final o in all) {
      final s = (o['status'] ?? 'new').toString();
      groups.putIfAbsent(s, () => <Map<String, dynamic>>[]).add(o);
    }
    final extras = groups.keys.where((k) => !offerStatuses.contains(k)).toList();

    // Sections that actually have rows, in pipeline order then extras.
    final sections = <String>[
      ...offerStatuses.where((s) => (groups[s] ?? const []).isNotEmpty),
      ...extras,
    ];

    return RefreshIndicator(
      onRefresh: widget.onRefresh,
      child: ListView.builder(
        padding: const EdgeInsets.fromLTRB(12, 4, 12, 100),
        itemCount: sections.length,
        itemBuilder: (context, i) {
          final status = sections[i];
          final rows = groups[status] ?? const [];
          return _Section(
            status: status,
            offers: rows,
            collapsed: _collapsed.contains(status),
            onToggle: () => setState(() {
              if (!_collapsed.remove(status)) _collapsed.add(status);
            }),
            onOpen: widget.onOpen,
            onApply: widget.onApply,
            onReject: widget.onReject,
            onTailor: widget.onTailor,
            onSetStatus: widget.onSetStatus,
            tailoring: widget.tailoring,
          );
        },
      ),
    );
  }
}

class _Section extends StatelessWidget {
  const _Section({
    required this.status,
    required this.offers,
    required this.collapsed,
    required this.onToggle,
    required this.onOpen,
    required this.onApply,
    required this.onReject,
    required this.onTailor,
    required this.onSetStatus,
    required this.tailoring,
  });

  final String status;
  final List<Map<String, dynamic>> offers;
  final bool collapsed;
  final VoidCallback onToggle;
  final void Function(Map<String, dynamic> o) onOpen;
  final void Function(String id) onApply;
  final void Function(String id) onReject;
  final void Function(Map<String, dynamic> o) onTailor;
  final void Function(String id, String status) onSetStatus;
  final Set<String> tailoring;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final style = offerStatusStyle(status);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        InkWell(
          onTap: onToggle,
          borderRadius: BorderRadius.circular(12),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(4, 12, 4, 8),
            child: Row(
              children: [
                Icon(style.icon, size: 18, color: style.color),
                const SizedBox(width: 8),
                Text(
                  style.label,
                  style: TextStyle(
                      color: style.color,
                      fontWeight: FontWeight.w800,
                      fontSize: 13.5),
                ),
                const SizedBox(width: 8),
                Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                  decoration: BoxDecoration(
                    color: style.color.withValues(alpha: 0.13),
                    borderRadius: BorderRadius.circular(999),
                  ),
                  child: Text('${offers.length}',
                      style: TextStyle(
                          fontSize: 12,
                          fontWeight: FontWeight.w800,
                          color: style.color)),
                ),
                const Spacer(),
                Icon(
                  collapsed ? Icons.expand_more : Icons.expand_less,
                  size: 20,
                  color: scheme.onSurfaceVariant,
                ),
              ],
            ),
          ),
        ),
        if (!collapsed)
          for (final o in offers)
            _SeenCard(
              offer: o,
              tailoring: tailoring,
              onOpen: onOpen,
              onApply: onApply,
              onReject: onReject,
              onTailor: onTailor,
              onSetStatus: onSetStatus,
            ),
      ],
    );
  }
}

/// A seen offer, shown compactly with the "Vu" memory front and centre: when
/// the user opened it and where they left it.
class _SeenCard extends StatelessWidget {
  const _SeenCard({
    required this.offer,
    required this.tailoring,
    required this.onOpen,
    required this.onApply,
    required this.onReject,
    required this.onTailor,
    required this.onSetStatus,
  });

  final Map<String, dynamic> offer;
  final Set<String> tailoring;
  final void Function(Map<String, dynamic> o) onOpen;
  final void Function(String id) onApply;
  final void Function(String id) onReject;
  final void Function(Map<String, dynamic> o) onTailor;
  final void Function(String id, String status) onSetStatus;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final id = (offer['id'] ?? '').toString();
    final status = (offer['status'] ?? 'new').toString();
    final title = (offer['title'] ?? 'Offre sans titre').toString();
    final company = cleanCompany(offer['company']);
    final seen = offerSeenAt(offer);
    final statusAt = offerStatusAt(offer);

    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      child: InkWell(
        borderRadius: BorderRadius.circular(12),
        onTap: () => onOpen(offer),
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: Text(
                      title,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                          fontSize: 13.5, fontWeight: FontWeight.w700, height: 1.25),
                    ),
                  ),
                  const SizedBox(width: 8),
                  // Tap the chip to move the offer, instead of dragging it
                  // across a board.
                  StatusChip(
                    label: offerStatusLabel(status),
                    color: offerStatusColor(status),
                    icon: offerStatusIcon(status),
                    onTap: () => onSetStatus(id, status),
                  ),
                ],
              ),
              if (company.isNotEmpty) ...[
                const SizedBox(height: 3),
                Text(company,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.w600,
                        color: scheme.onSurfaceVariant)),
              ],
              const SizedBox(height: 8),
              Wrap(
                spacing: 12,
                runSpacing: 4,
                children: [
                  if (seen != null)
                    _meta(context, Icons.visibility_outlined, 'Vu ${timeAgo(seen)}'),
                  if (statusAt != null && status != 'new')
                    _meta(context, Icons.flag_outlined, 'Statut ${timeAgo(statusAt)}'),
                ],
              ),
              const SizedBox(height: 10),
              Row(
                children: [
                  if (status != 'applied')
                    FilledButton.tonalIcon(
                      onPressed: () => onApply(id),
                      icon: const Icon(Icons.send_rounded, size: 16),
                      label: const Text('Postuler',
                          style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w700)),
                      style: FilledButton.styleFrom(
                        padding: const EdgeInsets.symmetric(
                            horizontal: 12, vertical: 9),
                      ),
                    ),
                  const SizedBox(width: 8),
                  OutlinedButton.icon(
                    onPressed: () => onOpen(offer),
                    icon: const Icon(Icons.open_in_new, size: 16),
                    label: const Text('Voir',
                        style: TextStyle(fontSize: 12.5)),
                    style: OutlinedButton.styleFrom(
                      padding: const EdgeInsets.symmetric(
                          horizontal: 12, vertical: 9),
                    ),
                  ),
                  const Spacer(),
                  if (tailoring.contains(id))
                    const SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(strokeWidth: 2.2),
                    )
                  else
                    IconButton(
                      onPressed: () => onTailor(offer),
                      icon: Icon(
                        offer['tailorStatus'] == 'ready'
                            ? Icons.check_circle
                            : Icons.edit_document,
                        size: 20,
                        color: offer['tailorStatus'] == 'ready'
                            ? const Color(0xFF2BB673)
                            : null,
                      ),
                      tooltip: 'Adapter',
                      visualDensity: VisualDensity.compact,
                    ),
                  if (status != 'applied')
                    IconButton(
                      onPressed: () => onReject(id),
                      icon: const Icon(Icons.close, size: 20),
                      tooltip: 'Refuser',
                      visualDensity: VisualDensity.compact,
                    ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _meta(BuildContext context, IconData icon, String text) {
    final scheme = Theme.of(context).colorScheme;
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(icon, size: 13, color: scheme.onSurfaceVariant),
        const SizedBox(width: 4),
        Text(text,
            style: TextStyle(
                fontSize: 12,
                color: scheme.onSurfaceVariant,
                fontWeight: FontWeight.w500)),
      ],
    );
  }
}

/// Loading placeholder for the Vu tab.
class SeenTabSkeleton extends StatelessWidget {
  const SeenTabSkeleton({super.key});

  @override
  Widget build(BuildContext context) {
    return ListView.builder(
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 100),
      itemCount: 5,
      itemBuilder: (_, _) => const Padding(
        padding: EdgeInsets.only(bottom: 10),
        child: SkeletonCard(),
      ),
    );
  }
}
