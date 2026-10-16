import 'package:flutter/material.dart';

import '../../../widgets/offer_card.dart';
import '../../../widgets/section_header.dart';
import '../../../widgets/skeleton.dart';
import '../offers_controller.dart';

/// Paginated, server-side result list. Sorts matches first, then by recency.
class ResultsTab extends StatelessWidget {
  const ResultsTab({
    super.key,
    required this.controller,
    required this.onOpen,
    required this.onApply,
    required this.onReject,
    required this.onTailor,
    required this.tailoring,
    required this.onRefresh,
    this.onChangeStatus,
  });

  final OffersController controller;
  final void Function(Map<String, dynamic> offer) onOpen;
  final void Function(String id, String status) onApply;
  final void Function(String id, String status) onReject;
  final void Function(Map<String, dynamic> offer) onTailor;
  final Set<String> tailoring;
  final Future<void> Function() onRefresh;

  /// Tap on the status chip: opens the status sheet. Replaces drag-and-drop.
  final void Function(Map<String, dynamic> offer)? onChangeStatus;

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: controller,
      builder: (context, _) {
        final items = controller.visibleItems;

        if (controller.loading && items.isEmpty) {
          return ListView.builder(
            padding: const EdgeInsets.fromLTRB(12, 4, 12, 100),
            itemCount: 4,
            itemBuilder: (_, _) => const Padding(
              padding: EdgeInsets.only(bottom: 10),
              child: SkeletonCard(),
            ),
          );
        }

        if (items.isEmpty) {
          return RefreshIndicator(
            onRefresh: onRefresh,
            child: ListView(
              padding: const EdgeInsets.fromLTRB(12, 4, 12, 100),
              children: [
                SizedBox(
                  height: 320,
                  child: Center(
                    child: Text(
                      controller.error ??
                          (controller.filters.isFiltering
                              ? 'Aucune offre ne correspond.\nÉlargis ta '
                                  'recherche ou réinitialise les filtres.'
                              : 'Aucune offre pour le moment.\n'
                                  'Le scan tourne en continu.'),
                      textAlign: TextAlign.center,
                      style: TextStyle(
                          color:
                              Theme.of(context).colorScheme.onSurfaceVariant),
                    ),
                  ),
                ),
              ],
            ),
          );
        }

        final sorted = [...items]..sort(_byRankThenRecency);

        return RefreshIndicator(
          onRefresh: onRefresh,
          child: ListView.builder(
            padding: const EdgeInsets.fromLTRB(12, 4, 12, 100),
            itemCount: sorted.length + (controller.hasMore ? 1 : 0),
            itemBuilder: (context, i) {
              if (i >= sorted.length) {
                return Padding(
                  padding: const EdgeInsets.symmetric(vertical: 16),
                  child: Center(
                    child: controller.loadingMore
                        ? const SizedBox(
                            width: 22,
                            height: 22,
                            child: CircularProgressIndicator(strokeWidth: 2.4),
                          )
                        : TextButton.icon(
                            onPressed: controller.loadMore,
                            icon: const Icon(Icons.expand_more, size: 18),
                            label: Text(
                              'Charger plus (${sorted.length}/${controller.total})',
                              style:
                                  const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w700),
                            ),
                          ),
                  ),
                );
              }

              final o = sorted[i];
              final id = (o['id'] ?? '').toString();
              final hasLink = (o['link'] ?? '').toString().isNotEmpty;

              return OfferCard(
                offer: o,
                id: id,
                tailoring: tailoring.contains(id),
                onTap: () => onOpen(o),
                onOpen: hasLink ? () => onOpen(o) : null,
                onApply: () => onApply(id, 'to_apply'),
                onReject: () => onReject(id, 'rejected'),
                onTailor: () => onTailor(o),
                onChangeStatus: onChangeStatus == null
                    ? null
                    : () => onChangeStatus!(o),
              );
            },
          ),
        );
      },
    );
  }

  /// Matches float to the top; within a tier, freshest first.
  static int _byRankThenRecency(Map<String, dynamic> a, Map<String, dynamic> b) {
    final r = (offerIsMatch(b) ? 1 : 0).compareTo(offerIsMatch(a) ? 1 : 0);
    if (r != 0) return r;
    return _timeOf(b).compareTo(_timeOf(a));
  }

  static DateTime _timeOf(Map<String, dynamic> o) =>
      offerTime(o) ?? DateTime.fromMillisecondsSinceEpoch(0);
}

/// "Dernières" tab: only unread offers, split into the last 24 h and the rest.
class LatestTab extends StatelessWidget {
  const LatestTab({
    super.key,
    required this.controller,
    required this.onOpen,
    required this.onApply,
    required this.onReject,
    required this.onTailor,
    required this.tailoring,
    required this.onRefresh,
    this.onChangeStatus,
  });

  final OffersController controller;
  final void Function(Map<String, dynamic> offer) onOpen;
  final void Function(String id, String status) onApply;
  final void Function(String id, String status) onReject;
  final void Function(Map<String, dynamic> offer) onTailor;
  final Set<String> tailoring;
  final Future<void> Function() onRefresh;

  /// Tap on the status chip: opens the status sheet. Replaces drag-and-drop.
  final void Function(Map<String, dynamic> offer)? onChangeStatus;

  static bool _isFresh(Map<String, dynamic> o) {
    final t = offerTime(o);
    if (t == null) return false;
    final diff = DateTime.now().difference(t.toLocal());
    return !diff.isNegative && diff.inHours < 24;
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: controller,
      builder: (context, _) {
        final unread = controller.visibleItems
            .where((o) => (o['status'] ?? 'new').toString() == 'new')
            .toList();
        if (controller.loading && unread.isEmpty) {
          return ListView.builder(
            padding: const EdgeInsets.fromLTRB(12, 4, 12, 100),
            itemCount: 4,
            itemBuilder: (_, _) => const Padding(
              padding: EdgeInsets.only(bottom: 10),
              child: SkeletonCard(),
            ),
          );
        }

        final fresh = unread.where(_isFresh).toList()..sort(_sort);
        final older = unread.where((o) => !_isFresh(o)).toList()..sort(_sort);

        Widget card(Map<String, dynamic> o) {
          final id = (o['id'] ?? '').toString();
          final hasLink = (o['link'] ?? '').toString().isNotEmpty;
          return OfferCard(
            offer: o,
            id: id,
            tailoring: tailoring.contains(id),
            onTap: () => onOpen(o),
            onOpen: hasLink ? () => onOpen(o) : null,
            onApply: () => onApply(id, 'to_apply'),
            onReject: () => onReject(id, 'rejected'),
            onTailor: () => onTailor(o),
            onChangeStatus: onChangeStatus == null
                ? null
                : () => onChangeStatus!(o),
          );
        }

        return RefreshIndicator(
          onRefresh: onRefresh,
          child: ListView(
            padding: const EdgeInsets.fromLTRB(12, 6, 12, 100),
            children: [
              SectionHeader(
                title: 'Offres du jour',
                subtitle: 'Détectées dans les 24 dernières heures (${fresh.length})',
              ),
              const SizedBox(height: 8),
              if (fresh.isEmpty)
                const Padding(
                  padding: EdgeInsets.only(bottom: 12),
                  child: Text('Aucune nouvelle offre dans les 24 dernières heures.'),
                )
              else
                for (final o in fresh) card(o),
              SectionHeader(
                title: 'Plus anciennes',
                subtitle: '${older.length} offres pas encore traitées',
              ),
              for (final o in older) card(o),
            ],
          ),
        );
      },
    );
  }

  static int _sort(Map<String, dynamic> a, Map<String, dynamic> b) {
    final r = (offerIsMatch(b) ? 1 : 0).compareTo(offerIsMatch(a) ? 1 : 0);
    if (r != 0) return r;
    return (offerTime(b) ?? DateTime.fromMillisecondsSinceEpoch(0))
        .compareTo(offerTime(a) ?? DateTime.fromMillisecondsSinceEpoch(0));
  }
}
