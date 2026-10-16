import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../app_state.dart';
import '../services/db_api.dart';
import '../theme/app_theme.dart';
import '../utils/company.dart';
import '../utils/time.dart';
import '../widgets/avatars.dart';
import '../widgets/status_chip.dart';
import '../widgets/offer_card.dart'
    show offerCity, offerCountry, offerIsMatch, offerKeywords, offerStatusLabel, offerTime;
import 'offres/widgets/apply_sheet.dart';

class OfferDetailScreen extends StatefulWidget {
  const OfferDetailScreen({super.key, required this.offer, required this.id});

  /// The list row this screen was opened with. It comes from
  /// /api/offers/search?fields=list and therefore has NO description: the offers
  /// table is 239MB, of which 93MB is description text, and carrying it in every
  /// list page cost 140KB per 30 rows for text only this screen renders. The full
  /// row is fetched on open instead (see [_full]).
  final Map<String, dynamic> offer;
  final String id;

  @override
  State<OfferDetailScreen> createState() => _OfferDetailScreenState();
}

class _OfferDetailScreenState extends State<OfferDetailScreen> {
  bool _tailoring = false;

  /// The authoritative offer row, including `description`.
  ///
  /// The widget arrives without a description (list rows are fetched with
  /// fields=list to keep pages small), so it is re-fetched here as a single row.
  /// The list row is kept as the fallback so the screen renders instantly with
  /// company/title/status/meta and fills in the body when the fetch lands; a
  /// failure just leaves the body empty instead of blocking the whole screen.
  Map<String, dynamic>? _full;

  /// True while the body is still missing, so the Description section can show a
  /// placeholder rather than silently rendering nothing.
  bool get _loadingBody => !(_full ?? widget.offer).containsKey('description');

  @override
  void initState() {
    super.initState();
    _loadFull();
  }

  Future<void> _loadFull() async {
    try {
      final full = await DbApi.offer(widget.id);
      if (full == null || !mounted) return;
      setState(() => _full = full);
    } catch (_) {
      // Offline or the offer was reaped. The list row still renders.
    }
  }

  Future<void> _openLink() async {
    final u = Uri.tryParse((widget.offer['link'] ?? '').toString());
    if (u == null) return;
    await launchUrl(u, mode: LaunchMode.externalApplication);
  }

  /// Status writes only — the manual apply sheet is opened by the Postuler
  /// button. No task is queued: auto-apply is frozen.
  Future<void> _setStatus(String status) async {
    try {
      await DbApi.updateOffer(widget.id, {'status': status});
    } catch (_) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Mise à jour impossible — API injoignable.')),
      );
      return;
    }
    if (!mounted) return;
    setState(() => widget.offer['status'] = status);
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(offerStatusLabel(status)), duration: const Duration(seconds: 1)),
    );
  }

  /// App-only application flow: link, tailored docs, then confirm.
  Future<void> _openApply() async {
    final done = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      backgroundColor: Colors.transparent,
      builder: (_) => ApplySheet(
        offer: widget.offer,
        offerId: widget.id,
        tailoring: _tailoring,
        onTailor: _tailor,
        onMarkApplied: (status) => _setStatus(status),
      ),
    );
    if (done == true && mounted) setState(() {});
  }

  Future<void> _tailor() async {
    if (_tailoring) return;
    setState(() => _tailoring = true);
    final ref = (widget.offer['ref'] ?? '').toString();
    final title = (widget.offer['title'] ?? '').toString();
    // "cv pro" selects the optional professional skin; chat-bot strips the token
    // before the task is queued (see takeCvTemplate in chat-bot.docker.js).
    final skin = AppState.cvPro.value ? ' cv pro' : '';
    await DbApi.sendChat('Adapter documents pour ${ref.isEmpty ? widget.id : ref} $title$skin', 'user');
    if (!mounted) return;
    setState(() => _tailoring = false);
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('Adaptation lancée — je te préviens quand c\'est prêt.')),
    );
  }

  @override
  Widget build(BuildContext context) {
    // Prefer the freshly fetched row (it carries the description); fall back to
    // the list row so the header, meta and actions are correct on the first frame.
    final o = _full ?? widget.offer;
    final scheme = Theme.of(context).colorScheme;
    final company = cleanCompany(o['company']);
    final status = (o['status'] ?? 'new').toString();
    final time = offerTime(o);
    final keywords = offerKeywords(o);
    final description = (o['description'] ?? '').toString().trim();
    final meta = <(String, String)>[
      if ((o['contract'] ?? '').toString().trim().isNotEmpty) ('Contrat', (o['contract'] ?? '').toString().trim()),
      if (offerCity(o).isNotEmpty) ('Lieu', offerCity(o)),
      if (offerCountry(o).isNotEmpty) ('Pays', offerCountry(o)),
      if ((o['ref'] ?? '').toString().isNotEmpty) ('Référence', (o['ref'] ?? '').toString()),
      if (time != null) ('Mise à jour', fmtFull(time)),
      if ((o['sourceId'] ?? o['source'] ?? '').toString().isNotEmpty) ('Source', (o['sourceId'] ?? o['source'] ?? '').toString()),
      if ((o['appliedAt'] ?? '').toString().isNotEmpty) ('Postulé le', fmtFull(o['appliedAt'])),
      if ((o['appliedBoard'] ?? '').toString().isNotEmpty) ('Candidature via', (o['appliedBoard'] ?? '').toString()),
      if ((o['applyReceipt'] ?? '').toString().isNotEmpty) ('Reçu', (o['applyReceipt'] ?? '').toString()),
    ];

    return Scaffold(
      appBar: AppBar(title: const Text('Offre')),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 110),
        children: [
          _header(scheme, company, status),
          if (offerIsMatch(o))
            Padding(
              padding: const EdgeInsets.only(top: 10),
              child: Align(alignment: Alignment.centerLeft, child: MatchChip()),
            ),
          const SizedBox(height: 16),
          if (meta.isNotEmpty) _metaCard(scheme, meta),
          if (keywords.isNotEmpty) ...[
            const SizedBox(height: 16),
            _section(scheme, 'Mots-clés', Wrap(
              spacing: 6,
              runSpacing: 4,
              children: [
                for (final k in keywords)
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
                    decoration: BoxDecoration(
                      color: scheme.primaryContainer.withValues(alpha: 0.5),
                      borderRadius: BorderRadius.circular(999),
                    ),
                    child: Text(k, style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: scheme.onPrimaryContainer)),
                  ),
              ],
            )),
          ],
          if (o['agentNote'].toString().isNotEmpty) ...[
            const SizedBox(height: 16),
            _section(scheme, 'Note de l\'agent', Text(
              o['agentNote'].toString(),
              style: Theme.of(context).textTheme.bodyMedium?.copyWith(fontStyle: FontStyle.italic),
            )),
          ],
          if (_loadingBody) ...[
            const SizedBox(height: 16),
            _section(
              scheme,
              'Description',
              Row(
                children: [
                  const SizedBox(
                    width: 14,
                    height: 14,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  ),
                  const SizedBox(width: 10),
                  Text(
                    'Chargement de la description\u2026',
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ],
              ),
            ),
          ] else if (description.isNotEmpty) ...[
            const SizedBox(height: 16),
            _section(scheme, 'Description', Text(
              description,
              style: Theme.of(context).textTheme.bodyMedium,
            )),
          ],
        ],
      ),
      bottomNavigationBar: SafeArea(
        top: false,
        child: Container(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
          decoration: BoxDecoration(
            color: scheme.surface,
            border: Border(top: BorderSide(color: scheme.outlineVariant.withValues(alpha: 0.5))),
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Row(
                children: [
                  Expanded(
                    child: OutlinedButton.icon(
                      onPressed: (o['link'] ?? '').toString().isEmpty ? null : _openLink,
                      icon: const Icon(Icons.open_in_new, size: 17),
                      label: const Text('Voir l\'annonce'),
                      style: OutlinedButton.styleFrom(padding: const EdgeInsets.symmetric(vertical: 13)),
                    ),
                  ),
                  if (status != 'applied') ...[
                    const SizedBox(width: 8),
                    Expanded(
                      child: FilledButton.icon(
                        onPressed: _openApply,
                        icon: const Icon(Icons.send_rounded, size: 17),
                        label: const Text('Postuler'),
                        style: FilledButton.styleFrom(padding: const EdgeInsets.symmetric(vertical: 13)),
                      ),
                    ),
                  ],
                ],
              ),
              const SizedBox(height: 8),
              ValueListenableBuilder<bool>(
                valueListenable: AppState.cvPro,
                builder: (_, pro, _) => Row(
                  children: [
                    Icon(
                      Icons.workspace_premium_outlined,
                      size: 18,
                      color: pro ? scheme.primary : scheme.onSurfaceVariant,
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        pro ? 'Modèle CV Pro' : 'Modèle CV standard',
                        style: TextStyle(
                          fontWeight: FontWeight.w600,
                          color: pro ? scheme.primary : scheme.onSurfaceVariant,
                        ),
                      ),
                    ),
                    Switch(
                      value: pro,
                      onChanged: (v) => AppState.cvPro.value = v,
                    ),
                  ],
                ),
              ),
              SizedBox(
                width: double.infinity,
                child: FilledButton.tonalIcon(
                  onPressed: _tailoring ? null : _tailor,
                  icon: _tailoring
                      ? const SizedBox(
                          width: 18,
                          height: 18,
                          child: CircularProgressIndicator(strokeWidth: 2.2),
                        )
                      : Icon(
                          o['tailorStatus'] == 'ready' ? Icons.check_circle : Icons.edit_document,
                          size: 18,
                        ),
                  label: Text(o['tailorStatus'] == 'ready'
                      ? 'Ré-adapter CV & lettre'
                      : 'Adapter CV & lettre'),
                  style: FilledButton.styleFrom(padding: const EdgeInsets.symmetric(vertical: 13)),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _header(ColorScheme scheme, String company, String status) {
    final o = widget.offer;
    return Container(
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(AppTheme.radius),
        gradient: Brand.gradient(),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              BrandAvatar(
                label: company.isEmpty ? (o['sourceId'] ?? 'J') : company,
                color: Colors.white.withValues(alpha: 0.9),
                size: 52,
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      (o['title'] ?? '').toString(),
                      style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w800, fontSize: 18, height: 1.25),
                    ),
                    const SizedBox(height: 5),
                    Text(
                      company,
                      style: TextStyle(color: Colors.white.withValues(alpha: 0.85), fontWeight: FontWeight.w600, fontSize: 13.5),
                    ),
                  ],
                ),
              ),
              StatusChip(label: offerStatusLabel(status), color: Colors.white, ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _metaCard(ColorScheme scheme, List<(String, String)> meta) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Wrap(
          spacing: 22,
          runSpacing: 14,
          children: [
            for (final (k, v) in meta)
              SizedBox(
                width: (MediaQuery.sizeOf(context).width - 32 - 44 - 22) / 2,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(k, style: TextStyle(fontSize: 11, color: scheme.onSurfaceVariant, fontWeight: FontWeight.w700, letterSpacing: 0.3)),
                    const SizedBox(height: 3),
                    Text(v, maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600)),
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }

  Widget _section(ColorScheme scheme, String title, Widget child) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Container(width: 4, height: 16, decoration: BoxDecoration(color: scheme.primary, borderRadius: BorderRadius.circular(3))),
            const SizedBox(width: 8),
            Text(title, style: Theme.of(context).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w800)),
          ],
        ),
        const SizedBox(height: 9),
        Card(
          child: Padding(
            padding: const EdgeInsets.all(14),
            child: SizedBox(width: double.infinity, child: child),
          ),
        ),
      ],
    );
  }
}