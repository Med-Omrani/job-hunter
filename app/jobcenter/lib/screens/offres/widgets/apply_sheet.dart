import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:open_filex/open_filex.dart';
import 'package:path_provider/path_provider.dart';
import 'package:share_plus/share_plus.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../services/db_api.dart';
import '../../../theme/app_theme.dart';
import '../../../widgets/avatars.dart';
import '../../../widgets/skeleton.dart';

/// One tailored document, ready to be attached to a job application.
class _Doc {
  final String id;
  final String label;
  final String type;
  _Doc(this.id, this.label, this.type);
}

/// Manual apply flow (auto-apply is frozen as of 2026-09-25).
///
/// Deliberately does NOT create a task or touch any browser automation. It
/// gathers exactly what a human needs to apply: the job link, the tailored CV
/// and cover letter, a checklist, and a one-tap "I applied" that writes the
/// status the app previously never set.
class ApplySheet extends StatefulWidget {
  const ApplySheet({
    super.key,
    required this.offer,
    required this.offerId,
    required this.onMarkApplied,
    this.onTailor,
    this.tailoring = false,
  });

  final Map<String, dynamic> offer;
  final String offerId;
  final Future<void> Function(String status) onMarkApplied;
  final VoidCallback? onTailor;
  final bool tailoring;

  @override
  State<ApplySheet> createState() => _ApplySheetState();
}

class _ApplySheetState extends State<ApplySheet> {
  List<_Doc> _docs = [];
  bool _loading = true;
  String _ref = '';
  bool _done = false;
  final Set<String> _opened = {};

  @override
  void initState() {
    super.initState();
    _ref = (widget.offer['ref'] ?? widget.offerId).toString();
    _loadDocs();
  }

  Future<void> _loadDocs() async {
    setState(() => _loading = true);
    try {
      final all = await DbApi.docs();
      // Match on offerRef first, then on the cv-<ref>/lettre-<ref> id convention.
      final byRef = all
          .where((d) {
            final or = (d['offerRef'] ?? d['offer_ref'] ?? '').toString();
            return or.isNotEmpty && or == _ref;
          })
          .map((d) => _Doc(
                (d['id'] ?? '').toString(),
                (d['name'] ?? d['id'] ?? 'Document').toString(),
                (d['type'] ?? '').toString(),
              ))
          .toList();
      if (byRef.isNotEmpty) {
        _docs = byRef;
      } else {
        _docs = all
            .where((d) => (d['id'] ?? '').toString().contains(_ref))
            .map((d) => _Doc(
                  (d['id'] ?? '').toString(),
                  (d['name'] ?? d['id'] ?? 'Document').toString(),
                  (d['type'] ?? '').toString(),
                ))
            .toList();
      }
    } catch (_) {
      _docs = [];
    }
    if (mounted) setState(() => _loading = false);
  }

  _Doc? _pick(String type) {
    for (final d in _docs) {
      if (d.type.toLowerCase().contains(type)) return d;
    }
    return null;
  }

  String get _link {
    final u = (widget.offer['link'] ?? '').toString();
    if (u.isNotEmpty) return u;
    return (widget.offer['applyUrl'] ?? '').toString();
  }

  Future<void> _openLink() async {
    final u = Uri.tryParse(_link);
    if (u == null) return;
    await launchUrl(u, mode: LaunchMode.externalApplication);
    if (mounted) setState(() => _opened.add('link'));
  }

  /// Writes the PDF to a temp file and opens the system share sheet so the user
  /// can attach it to the application form. Mirrors the docs screen flow.
  Future<void> _shareDoc(_Doc d) async {
    final messenger = ScaffoldMessenger.of(context);
    final bytes = await DbApi.pdfBytes(d.id);
    if (bytes.isEmpty) {
      messenger.showSnackBar(
        const SnackBar(content: Text('Document vide ou indisponible')),
      );
      return;
    }
    try {
      final dir = await getTemporaryDirectory();
      final name = '${_ref}_${d.type == 'cv' ? 'CV' : 'LETTRE'}.pdf'
          .replaceAll(RegExp(r'[^A-Za-z0-9_.-]'), '_');
      final file = File('${dir.path}/$name');
      await file.writeAsBytes(bytes, flush: true);
      final result = await SharePlus.instance.share(ShareParams(
        files: [XFile(file.path, mimeType: 'application/pdf')],
        fileNameOverrides: [name],
        subject: '${d.label} — $_ref',
        text: '${d.label} pour $_ref',
      ));
      if (result.status == ShareResultStatus.dismissed) return;
    } catch (_) {
      messenger.showSnackBar(
        SnackBar(content: Text('Impossible d\'ouvrir ${d.label}')),
      );
      return;
    }
    if (!mounted) return;
    setState(() => _opened.add(d.id));
  }

  /// Opens the PDF in the system viewer (preview instead of share).
  Future<void> _previewDoc(_Doc d) async {
    final messenger = ScaffoldMessenger.of(context);
    final bytes = await DbApi.pdfBytes(d.id);
    if (bytes.isEmpty) {
      messenger.showSnackBar(
        const SnackBar(content: Text('Document vide ou indisponible')),
      );
      return;
    }
    try {
      final dir = await getTemporaryDirectory();
      final name = '${_ref}_${d.type == 'cv' ? 'CV' : 'LETTRE'}.pdf'
          .replaceAll(RegExp(r'[^A-Za-z0-9_.-]'), '_');
      final file = File('${dir.path}/$name');
      await file.writeAsBytes(bytes, flush: true);
      final result = await OpenFilex.open(file.path, type: 'application/pdf');
      if (result.type != ResultType.done) {
        messenger.showSnackBar(
          const SnackBar(content: Text('Aucune app pour lire ce PDF')),
        );
        return;
      }
    } catch (_) {
      messenger.showSnackBar(
        SnackBar(content: Text('Impossible d\'ouvrir ${d.label}')),
      );
      return;
    }
    if (!mounted) return;
    setState(() => _opened.add(d.id));
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final o = widget.offer;
    final company = (o['company'] ?? '').toString();
    final title = (o['title'] ?? '').toString();
    final status = (o['status'] ?? 'new').toString();
    final cv = _pick('cv');
    final lettre = _pick('lettre');
    final linkOk = _link.isNotEmpty;

    return DraggableScrollableSheet(
      expand: false,
      initialChildSize: 0.82,
      minChildSize: 0.5,
      maxChildSize: 0.95,
      builder: (context, scrollCtrl) => Container(
        decoration: BoxDecoration(
          color: scheme.surface,
          borderRadius: const BorderRadius.vertical(top: Radius.circular(24)),
        ),
        child: Column(
          children: [
            const SizedBox(height: 10),
            Container(
              width: 40,
              height: 4,
              decoration: BoxDecoration(
                color: scheme.outlineVariant,
                borderRadius: BorderRadius.circular(2),
              ),
            ),
            Expanded(
              child: ListView(
                controller: scrollCtrl,
                padding: const EdgeInsets.fromLTRB(16, 14, 16, 16),
                children: [
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      BrandAvatar(
                        label: company.isEmpty ? 'J' : company,
                        color: Brand.colorFor(company),
                        size: 44,
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(title,
                                style: Theme.of(context)
                                    .textTheme
                                    .titleMedium
                                    ?.copyWith(fontWeight: FontWeight.w800)),
                            if (company.isNotEmpty)
                              Text(company,
                                  style: TextStyle(
                                      color: scheme.onSurfaceVariant,
                                      fontWeight: FontWeight.w600)),
                          ],
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 16),
                  Text('Ta candidature, en 3 étapes',
                      style: Theme.of(context)
                          .textTheme
                          .titleSmall
                          ?.copyWith(fontWeight: FontWeight.w800)),
                  const SizedBox(height: 12),
                  _step(
                    context,
                    n: 1,
                    done: _opened.contains('link'),
                    title: 'Ouvre l\'annonce',
                    subtitle: linkOk
                        ? _link
                        : 'Aucun lien sur cette offre — cherche-la sur la source.',
                    action: linkOk
                        ? FilledButton.icon(
                            onPressed: _openLink,
                            icon: const Icon(Icons.open_in_new, size: 17),
                            label: const Text('Ouvrir l\'annonce'),
                            style: FilledButton.styleFrom(
                                padding:
                                    const EdgeInsets.symmetric(vertical: 12)),
                          )
                        : null,
                  ),
                  _step(
                    context,
                    n: 2,
                    done: cv != null && lettre != null,
                    title: 'Joins tes documents',
                    subtitle: _loading
                        ? 'Chargement…'
                        : _docs.isEmpty
                            ? 'Pas encore de CV adapté pour cette offre.'
                            : '${_docs.length} document(s) prêt(s) à joindre.',
                    child: _loading
                        ? Column(
                            children: const [
                              SkeletonCard(height: 54),
                              SkeletonCard(height: 54),
                            ],
                          )
                        : _docs.isEmpty
                            ? (widget.onTailor == null
                                ? const SizedBox.shrink()
                                : FilledButton.tonalIcon(
                                    onPressed: widget.tailoring
                                        ? null
                                        : widget.onTailor,
                                    icon: widget.tailoring
                                        ? const SizedBox(
                                            width: 16,
                                            height: 16,
                                            child: CircularProgressIndicator(
                                                strokeWidth: 2.2),
                                          )
                                        : const Icon(Icons.edit_document, size: 17),
                                    label: const Text('Adapter CV & lettre'),
                                    style: FilledButton.styleFrom(
                                        padding: const EdgeInsets.symmetric(
                                            vertical: 12)),
                                  ))
                            : Column(
                                children: [
                                  for (final d in _docs) _docRow(context, d),
                                ],
                              ),
                  ),
                  _step(
                    context,
                    n: 3,
                    done: status == 'applied',
                    title: 'Envoie, puis confirme',
                    subtitle: status == 'applied'
                        ? 'Candidature marquée comme envoyée.'
                        : 'Une fois postulé, confirme ici pour suivre tes candidatures.',
                    action: status == 'applied'
                        ? null
                        : FilledButton.icon(
                            onPressed: _done ? null : () => _markApplied(cv, lettre),
                            icon: const Icon(Icons.check_circle_outline, size: 17),
                            label: const Text('J\'ai postulé'),
                            style: FilledButton.styleFrom(
                                backgroundColor: const Color(0xFF2BB673),
                                padding:
                                    const EdgeInsets.symmetric(vertical: 13)),
                          ),
                  ),
                  const SizedBox(height: 8),
                  if (_link.isNotEmpty)
                    TextButton.icon(
                      onPressed: () async {
                        await Clipboard.setData(ClipboardData(text: _link));
                        if (!context.mounted) return;
                        ScaffoldMessenger.of(context).showSnackBar(
                          const SnackBar(content: Text('Lien copié')),
                        );
                      },
                      icon: const Icon(Icons.copy, size: 15),
                      label: const Text('Copier le lien'),
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _markApplied(_Doc? cv, _Doc? lettre) async {
    setState(() => _done = true);
    final board = Uri.tryParse(_link)?.host ?? '';
    await widget.onMarkApplied('applied');
    if (!mounted) return;
    Navigator.of(context).pop(true);
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          [
            'Candidature enregistrée',
            if (board.isNotEmpty) board,
            if (cv != null || lettre != null) 'CV + lettre joints',
          ].join(' · '),
        ),
      ),
    );
  }

  Widget _docRow(BuildContext context, _Doc d) {
    final scheme = Theme.of(context).colorScheme;
    final isCv = d.type.toLowerCase().contains('cv');
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Container(
        padding: const EdgeInsets.all(11),
        decoration: BoxDecoration(
          color: scheme.surfaceContainerHigh,
          borderRadius: BorderRadius.circular(12),
        ),
        child: Row(
          children: [
            Icon(isCv ? Icons.badge_outlined : Icons.description_outlined,
                size: 20, color: scheme.primary),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(isCv ? 'CV adapté' : 'Lettre adaptée',
                      style: const TextStyle(
                          fontSize: 13, fontWeight: FontWeight.w800)),
                  Text(d.id,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: 11, color: scheme.onSurfaceVariant)),
                ],
              ),
            ),
            const SizedBox(width: 6),
            IconButton(
              onPressed: () => _previewDoc(d),
              tooltip: 'Prévisualiser',
              icon: const Icon(Icons.visibility_outlined, size: 20),
              style: IconButton.styleFrom(
                backgroundColor: scheme.surface,
                shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(10)),
              ),
            ),
            const SizedBox(width: 6),
            FilledButton.tonal(
              onPressed: () => _shareDoc(d),
              style: FilledButton.styleFrom(
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9)),
              child: const Text('Joindre', style: TextStyle(fontSize: 12.5)),
            ),
          ],
        ),
      ),
    );
  }

  Widget _step(
    BuildContext context, {
    required int n,
    required bool done,
    required String title,
    required String subtitle,
    Widget? action,
    Widget? child,
  }) {
    final scheme = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 26,
            height: 26,
            decoration: BoxDecoration(
              color: done ? const Color(0xFF2BB673) : scheme.primaryContainer,
              shape: BoxShape.circle,
            ),
            child: Center(
              child: done
                  ? const Icon(Icons.check, size: 16, color: Colors.white)
                  : Text('$n',
                      style: TextStyle(
                          fontSize: 12.5,
                          fontWeight: FontWeight.w800,
                          color: scheme.onPrimaryContainer)),
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title,
                    style: const TextStyle(
                        fontSize: 14, fontWeight: FontWeight.w800)),
                const SizedBox(height: 2),
                Text(subtitle,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                        fontSize: 12, color: scheme.onSurfaceVariant)),
                if (child != null) ...[const SizedBox(height: 10), child],
                if (action != null) ...[const SizedBox(height: 10), action],
              ],
            ),
          ),
        ],
      ),
    );
  }
}
