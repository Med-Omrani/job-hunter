import 'package:flutter/material.dart';

import '../theme/app_theme.dart';
import '../utils/company.dart';
import '../utils/time.dart';
import 'avatars.dart';
import 'status_chip.dart';

export 'status_chip.dart'
    show
        StatusChip,
        offerStatusColor,
        offerStatusLabel,
        offerStatusStyle,
        offerStatuses,
        offerStatusIcon;

/// When the user set the current status. Falls back to the posting time so an
/// offer touched before this field existed still shows a plausible age.
DateTime? offerStatusAt(Map<String, dynamic> o) =>
    _parseTs(o['statusAt']) ?? offerTime(o);

/// When the user actually opened the offer ("Vu").
DateTime? offerSeenAt(Map<String, dynamic> o) => _parseTs(o['seenAt']);

DateTime? _parseTs(dynamic v) {
  if (v is DateTime) return v;
  if (v is String) {
    final d = DateTime.tryParse(v);
    if (d != null) return d;
  }
  if (v is Map && v.containsKey('_seconds')) {
    return DateTime.fromMillisecondsSinceEpoch((v['_seconds'] as num).toInt() * 1000);
  }
  return null;
}

bool offerIsMatch(Map<String, dynamic> o) {
  if (o['match'] == true) return true;
  final s = o['score'];
  return s is num && s >= 2;
}

String offerCountry(Map<String, dynamic> o) {
  final c = (o['country'] ?? '').toString().trim();
  if (c.isNotEmpty) return c;
  final loc = offerLoc(o);
  if (loc.contains('distance') || loc.contains('remote')) return 'À distance';
  return '';
}

String offerLoc(Map<String, dynamic> o) => (o['location'] ?? '').toString().trim();

String offerCity(Map<String, dynamic> o) {
  final loc = offerLoc(o);
  if (loc.isEmpty) return '';
  if (loc.contains('distance') || loc.contains('remote')) return 'À distance';
  return loc;
}

DateTime? offerTime(Map<String, dynamic> o) {
  for (final k in ['postedAt', 'posted', 'updatedAt']) {
    final v = o[k];
    if (v is DateTime) return v;
    if (v is String) {
      final d = DateTime.tryParse(v);
      if (d != null) return d;
    }
    if (v is Map && v.containsKey('_seconds')) {
      return DateTime.fromMillisecondsSinceEpoch((v['_seconds'] as num).toInt() * 1000);
    }
  }
  return null;
}

List<String> offerKeywords(Map<String, dynamic> o) {
  final raw = o['keywords'];
  if (raw is! List) return const [];
  final out = <String>[];
  for (final k in raw) {
    final s = k
        .toString()
        .replaceAll(RegExp(r'<[^>]*>'), ' ')
        .replaceAll('&amp;', '&')
        .replaceAll(RegExp(r'\s+'), ' ')
        .trim();
    if (s.isNotEmpty) out.add(s);
  }
  return out;
}

class OfferCard extends StatelessWidget {
  const OfferCard({
    super.key,
    required this.offer,
    required this.id,
    this.tailoring = false,
    this.compact = false,
    this.onTap,
    this.onOpen,
    this.onApply,
    this.onReject,
    this.onTailor,
    this.onChangeStatus,
  });

  final Map<String, dynamic> offer;
  final String id;
  final bool tailoring;
  final bool compact;
  final VoidCallback? onTap;
  final VoidCallback? onOpen;
  final VoidCallback? onApply;
  final VoidCallback? onReject;
  final VoidCallback? onTailor;

  /// Opens the status picker. Replaces the old drag-and-drop board: on a phone
  /// a long-press drag across a horizontal scroll view was a mis-touch magnet.
  final VoidCallback? onChangeStatus;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final title = (offer['title'] ?? '').toString();
    final company = cleanCompany(offer['company']);
    final status = (offer['status'] ?? 'new').toString();
    final country = offerCountry(offer);
    final loc = offerLoc(offer);
    final match = offerIsMatch(offer);
    final tailorDone = offer['tailorStatus'] == 'ready';
    final ref = (offer['ref'] ?? '').toString();
    final time = offerTime(offer);
    final statusAt = offerStatusAt(offer);
    final keywords = offerKeywords(offer);
    final unread = offerSeenAt(offer) == null;

    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      child: InkWell(
        borderRadius: BorderRadius.circular(AppTheme.radius),
        onTap: onTap,
        child: Padding(
          padding: EdgeInsets.all(compact ? 12 : 14),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  BrandAvatar(
                    label: company.isEmpty ? (offer['sourceId'] ?? 'J') : company,
                    color: Brand.colorFor(company.isEmpty ? (offer['sourceId'] ?? 'job') : company),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          title,
                          maxLines: compact ? 1 : 2,
                          overflow: TextOverflow.ellipsis,
                          style: Theme.of(context)
                              .textTheme
                              .titleSmall
                              ?.copyWith(fontWeight: FontWeight.w700, height: 1.25),
                        ),
                        const SizedBox(height: 4),
                        Text(
                          company,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: Theme.of(context)
                              .textTheme
                              .bodySmall
                              ?.copyWith(color: scheme.onSurfaceVariant, fontWeight: FontWeight.w600),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 8),
                  StatusChip(
                    label: offerStatusLabel(status),
                    color: offerStatusColor(status),
                    icon: offerStatusIcon(status),
                    onTap: onChangeStatus,
                  ),
                ],
              ),
              if (unread)
                Padding(
                  padding: const EdgeInsets.only(top: 6),
                  child: Row(
                    children: [
                      Container(
                        width: 7,
                        height: 7,
                        decoration: const BoxDecoration(
                            color: Color(0xFF1B6EF3), shape: BoxShape.circle),
                      ),
                      const SizedBox(width: 5),
                      Text('Pas encore vue',
                          style: TextStyle(
                              fontSize: 10.5,
                              fontWeight: FontWeight.w700,
                              color: scheme.primary)),
                    ],
                  ),
                ),
              const SizedBox(height: 8),
              Wrap(
                spacing: 14,
                runSpacing: 4,
                children: [
                  if (company.isNotEmpty && loc.isNotEmpty)
                    _meta(context, Icons.place_outlined, offerCity(offer)),
                  if (country.isNotEmpty && country != offerCity(offer))
                    _meta(context, Icons.public, country),
                  if (offer['contract'].toString().trim().isNotEmpty)
                    _meta(context, Icons.badge_outlined, (offer['contract'] ?? '').toString().trim()),
                  if (ref.isNotEmpty) _meta(context, Icons.tag, 'Réf $ref'),
                  if (time != null)
                    _meta(context, Icons.schedule, timeAgo(time)),
                  if (statusAt != null && status != 'new')
                    _meta(context, Icons.flag_outlined,
                        'Statut ${timeAgo(statusAt)}'),
                ],
              ),
              if (match)
                Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: Align(
                    alignment: Alignment.centerLeft,
                    child: MatchChip(),
                  ),
                ),
              if (!compact && keywords.isNotEmpty) ...[
                const SizedBox(height: 8),
                Wrap(
                  spacing: 6,
                  runSpacing: 4,
                  children: [
                    for (final k in keywords.take(4))
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                        decoration: BoxDecoration(
                          color: scheme.surfaceContainerHigh,
                          borderRadius: BorderRadius.circular(999),
                        ),
                        child: Text(
                          k,
                          style: TextStyle(fontSize: 11, color: scheme.onSurfaceVariant, fontWeight: FontWeight.w600),
                        ),
                      ),
                  ],
                ),
              ],
              if (!compact && offer['agentNote'].toString().isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(top: 6),
                  child: Text(
                    offer['agentNote'].toString(),
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context).textTheme.bodySmall?.copyWith(fontStyle: FontStyle.italic),
                  ),
                ),
              const SizedBox(height: 10),
              Wrap(
                spacing: 8,
                runSpacing: 6,
                children: [
                  OutlinedButton.icon(
                    onPressed: onOpen,
                    icon: const Icon(Icons.open_in_new, size: 17),
                    label: const Text('Voir', style: TextStyle(fontSize: 13)),
                    style: OutlinedButton.styleFrom(
                      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                    ),
                  ),
                  if (status != 'applied' && onApply != null)
                    FilledButton.tonalIcon(
                      onPressed: onApply,
                      icon: const Icon(Icons.send_rounded, size: 17),
                      label: Text('Postuler', style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w700)),
                      style: FilledButton.styleFrom(
                        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                      ),
                    ),
                  if (onTailor != null)
                    tailoring
                        ? const Padding(
                            padding: EdgeInsets.symmetric(horizontal: 8, vertical: 8),
                            child: SizedBox(
                              width: 20,
                              height: 20,
                              child: CircularProgressIndicator(strokeWidth: 2.2),
                            ),
                          )
                        : OutlinedButton.icon(
                            onPressed: onTailor,
                            icon: Icon(
                              tailorDone ? Icons.check_circle : Icons.edit_document,
                              size: 17,
                              color: tailorDone ? const Color(0xFF2E7D32) : null,
                            ),
                            label: Text(
                              tailorDone ? 'Ré-adapter' : 'Adapter',
                              style: TextStyle(
                                fontSize: 13,
                                color: tailorDone ? const Color(0xFF2E7D32) : null,
                                fontWeight: FontWeight.w700,
                              ),
                            ),
                            style: OutlinedButton.styleFrom(
                              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                            ),
                          ),
                  if (onReject != null && status != 'applied')
                    IconButton(
                      onPressed: onReject,
                      icon: const Icon(Icons.close),
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
        Text(
          text,
          style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant, fontWeight: FontWeight.w500),
        ),
      ],
    );
  }
}