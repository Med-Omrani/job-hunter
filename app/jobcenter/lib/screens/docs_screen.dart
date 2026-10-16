import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:open_filex/open_filex.dart';
import 'package:path_provider/path_provider.dart';
import 'package:share_plus/share_plus.dart';
import 'package:url_launcher/url_launcher.dart';

import '../services/db_api.dart';
import '../utils/time.dart';
import '../widgets/empty_state.dart';
import '../widgets/section_header.dart';
import '../widgets/skeleton.dart';

/// Docker-backed doc (same call shape as Firestore snapshots: d.id + d.data()).
class DocRef {
  final String id;
  final Map<String, dynamic> _d;
  const DocRef(this.id, this._d);
  Map<String, dynamic> data() => _d;
}

class DocsScreen extends StatefulWidget {
  const DocsScreen({super.key});

  @override
  State<DocsScreen> createState() => _DocsScreenState();
}

class _DocsScreenState extends State<DocsScreen> {
  List<DocRef> _docs = [];
  bool _loaded = false;
  Timer? _poll;

  @override
  void initState() {
    super.initState();
    _reload();
    _poll = Timer.periodic(const Duration(seconds: 15), (_) => _reload(silent: true));
  }

  @override
  void dispose() {
    _poll?.cancel();
    super.dispose();
  }

  Future<void> _reload({bool silent = false}) async {
    try {
      final list = await DbApi.docs();
      if (!mounted) return;
      setState(() {
        _docs = list.map((m) => DocRef((m['id'] ?? '').toString(), m)).toList();
        _loaded = true;
      });
    } catch (_) {
      if (!mounted) return;
      if (!silent) setState(() => _loaded = true);
    }
  }

  Future<void> _openUrl(String url) async {
    final u = Uri.tryParse(url);
    if (u == null) return;
    await launchUrl(u, mode: LaunchMode.externalApplication);
  }

  Future<List<int>?> _fetchPdfBytes(DocRef doc) async {
    try {
      final bytes = await DbApi.pdfBytes(doc.id);
      if (bytes.isEmpty) return null;
      return bytes;
    } catch (_) {
      return null;
    }
  }

  Future<void> _openPdf(DocRef doc, BuildContext context) async {
    final messenger = ScaffoldMessenger.of(context);
    final d = doc.data();
    final bytes = await _fetchPdfBytes(doc);
    if (bytes == null) {
      messenger.showSnackBar(_noLink);
      return;
    }
    try {
      final dir = await getTemporaryDirectory();
      final name = _safeName(d);
      final file = File('${dir.path}/$name');
      await file.writeAsBytes(bytes, flush: true);
      final result = await OpenFilex.open(file.path, type: 'application/pdf');
      if (result.type != ResultType.done) {
        messenger.showSnackBar(_noLink);
      }
    } catch (_) {
      messenger.showSnackBar(_noLink);
    }
  }

  Future<void> _downloadPdf(DocRef doc, BuildContext context) async {
    final messenger = ScaffoldMessenger.of(context);
    final d = doc.data();
    final bytes = await _fetchPdfBytes(doc);
    if (bytes == null) {
      messenger.showSnackBar(_noLink);
      return;
    }
    try {
      final dir = await getTemporaryDirectory();
      final name = _safeName(d);
      final file = File('${dir.path}/$name');
      await file.writeAsBytes(bytes, flush: true);
      final result = await SharePlus.instance.share(ShareParams(
        files: [XFile(file.path, mimeType: 'application/pdf')],
        fileNameOverrides: [name],
        subject: (d['name'] ?? 'Document').toString(),
        text: (d['name'] ?? 'Document').toString(),
      ));
      if (result.status == ShareResultStatus.dismissed) {
        messenger.showSnackBar(
            const SnackBar(content: Text('Partage annulé'), duration: Duration(seconds: 2)));
      }
    } catch (_) {
      messenger.showSnackBar(_noLink);
    }
  }

  String _safeName(Map<String, dynamic> d) {
    final type = (d['type'] ?? 'cv').toString();
    final base = type == 'cv' ? 'CV_Mohamed_Omrani' : 'Lettre_Mohamed_Omrani';
    final ref = (d['offerRef'] ?? '').toString();
    final suffix = ref.isNotEmpty
        ? ref.replaceAll(RegExp(r'[^A-Za-z0-9_-]+'), '_').replaceAll(RegExp(r'_+'), '_')
        : '${base}_${DateTime.now().toIso8601String().split('T').first}';
    return '$base-$suffix.pdf';
  }

  void _smartOpen(DocRef doc, BuildContext context) {
    final d = doc.data();
    final url = (d['url'] ?? '').toString();
    if (url.isNotEmpty) {
      _openUrl(url);
    } else {
      _openPdf(doc, context);
    }
  }

  SnackBar get _noLink => const SnackBar(
      content: Text('Impossible d ouvrir ce document'),
      duration: Duration(seconds: 2));

  String _typeLabel(String type) =>
      type == 'cv' ? 'Curriculum Vitae' : 'Lettre de motivation';

  bool _isBase(Map<String, dynamic> d) =>
      d['original'] == true || d['kind'] == 'current';

  int _kindRank(Map<String, dynamic> d) {
    if (d['original'] == true) return 0;
    if (d['kind'] == 'current') return 1;
    return 2;
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('CV & Lettres')),
      body: !_loaded
          ? const SkeletonList(count: 4)
          : _docsBody(),
    );
  }

  Widget _docsBody() {
    final docs = _docs;
    if (docs.isEmpty) {
      return const EmptyState(
        icon: Icons.folder_open,
        title: 'Tes documents apparaîtront ici',
        subtitle:
            'Demande « pdfs » à ton agent, ou adapte une offre dans l\'onglet Offres.',
      );
    }

    final sorted = [...docs]
      ..sort((a, b) {
        final k = _kindRank(a.data()) - _kindRank(b.data());
        if (k != 0) return k;
        return timeToDate(a.data()['updatedAt'])
            .compareTo(timeToDate(b.data()['updatedAt']));
      });

    final base = sorted.where((d) => _isBase(d.data())).toList();
    final adapted = sorted.where((d) => !_isBase(d.data())).toList();

    final groups = <String, List<DocRef>>{};
    for (final d in adapted) {
      final ref = (d.data()['offerRef'] ?? '').toString().trim();
      groups.putIfAbsent(ref.isEmpty ? 'doc-${d.id}' : ref, () => []).add(d);
    }
    final groupEntries = groups.entries.toList()
      ..sort((a, b) => _groupTime(b.value).compareTo(_groupTime(a.value)));

    return ListView(
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 100),
      children: [
        const SectionHeader(
          title: 'Documents de base',
          subtitle: 'Ton CV et ta lettre à jour, prêts à envoyer',
        ),
        for (final d in base) _docCard(d, context),
        if (groupEntries.isNotEmpty) ...[
          const SizedBox(height: 8),
          const SectionHeader(
            title: 'Adaptés par offre',
            subtitle: 'CV + lettre sur mesure, groupés par candidature',
          ),
          for (final e in groupEntries) _groupCard(e.key, e.value, context),
        ],
      ],
    );
  }

  Widget _docCard(DocRef doc, BuildContext context) {
    final d = doc.data();
    final scheme = Theme.of(context).colorScheme;
    final type = (d['type'] ?? 'cv').toString();
    final url = (d['url'] ?? '').toString();
    final ref = (d['offerRef'] ?? '').toString();
    final updated = d['updatedAt'];
    final (kind, kindColor, kindBg) = _kindBadge(d);
    const openable = true;

    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      child: InkWell(
        borderRadius: BorderRadius.circular(14),
        onTap: () => _smartOpen(doc, context),
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Row(
            children: [
              Container(
                width: 46,
                height: 46,
                decoration: BoxDecoration(
                  gradient: LinearGradient(
                    begin: Alignment.topLeft,
                    end: Alignment.bottomRight,
                    colors: [scheme.primary, scheme.primary.withValues(alpha: 0.7)],
                  ),
                  borderRadius: BorderRadius.circular(12),
                ),
                alignment: Alignment.center,
                child: Icon(
                  type == 'cv' ? Icons.picture_as_pdf : Icons.description_rounded,
                  color: Colors.white,
                  size: 22,
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      (d['name'] ?? 'Document').toString(),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: Theme.of(context)
                          .textTheme
                          .titleSmall
                          ?.copyWith(fontWeight: FontWeight.w800),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      _typeLabel(type),
                      style: TextStyle(
                          fontSize: 11.5, color: scheme.onSurfaceVariant, fontWeight: FontWeight.w500),
                    ),
                    if (ref.isNotEmpty || updated != null) ...[
                      const SizedBox(height: 2),
                      Text(
                        ref.isNotEmpty
                            ? 'Réf $ref · Mise à jour : ${fmtFull(updated)}'
                            : 'Mise à jour : ${fmtFull(updated)}',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                            fontSize: 11, color: scheme.onSurfaceVariant.withValues(alpha: 0.8)),
                      ),
                    ],
                  ],
                ),
              ),
              const SizedBox(width: 6),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
                decoration: BoxDecoration(
                  color: kindBg,
                  borderRadius: BorderRadius.circular(999),
                ),
                child: Text(
                  kind,
                  style: TextStyle(color: kindColor, fontSize: 10.5, fontWeight: FontWeight.w800),
                ),
              ),
              const SizedBox(width: 2),
              _actionIcon(Icons.open_in_new_rounded, 'Ouvrir',
                  () => _smartOpen(doc, context),
                  enabled: openable),
              _actionIcon(Icons.ios_share_outlined, 'Partager / télécharger',
                  () => _downloadPdf(doc, context),
                  enabled: openable),
              _actionIcon(Icons.delete_outline_rounded, 'Supprimer',
                  () => _confirmDelete(doc, context)),
            ],
          ),
        ),
      ),
    );
  }

  Widget _groupCard(String ref,
      List<DocRef> docs, BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final title = _parseGroupTitle(docs.first.data());
    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      child: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(13, 12, 6, 8),
            child: Row(
              children: [
                Container(
                  width: 42,
                  height: 42,
                  decoration: BoxDecoration(
                    gradient: LinearGradient(
                      begin: Alignment.topLeft,
                      end: Alignment.bottomRight,
                      colors: [scheme.secondary, scheme.primary],
                    ),
                    borderRadius: BorderRadius.circular(12),
                  ),
                  alignment: Alignment.center,
                  child: const Icon(Icons.folder_outlined, color: Colors.white, size: 21),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        title,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: Theme.of(context)
                            .textTheme
                            .titleSmall
                            ?.copyWith(fontWeight: FontWeight.w800),
                      ),
                      const SizedBox(height: 3),
                      Text(
                        'Réf $ref · ${docs.length} document${docs.length > 1 ? 's' : ''} · ${fmtFull(_groupTime(docs))}',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(fontSize: 11.5, color: scheme.onSurfaceVariant),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
          Divider(height: 1, indent: 11, endIndent: 11, color: scheme.outlineVariant.withValues(alpha: 0.4)),
          for (final doc in docs) _tileRow(doc, context),
        ],
      ),
    );
  }

  Widget _tileRow(DocRef doc, BuildContext context) {
    final d = doc.data();
    final scheme = Theme.of(context).colorScheme;
    final type = (d['type'] ?? 'cv').toString();
    final url = (d['url'] ?? '').toString();
    final updated = d['updatedAt'];
    const openable = true;

    return InkWell(
      borderRadius: BorderRadius.circular(12),
      onTap: () => _smartOpen(doc, context),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(13, 4, 2, 4),
        child: Row(
          children: [
            Container(
              width: 36,
              height: 36,
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                  colors: [scheme.secondary, scheme.primary],
                ),
                borderRadius: BorderRadius.circular(10),
              ),
              alignment: Alignment.center,
              child: Icon(
                type == 'cv' ? Icons.picture_as_pdf : Icons.description_rounded,
                color: Colors.white,
                size: 19,
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    type == 'cv' ? 'Curriculum Vitae' : 'Lettre de motivation',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w700, color: scheme.onSurface),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    updated != null ? 'Adapté le ${fmtFull(updated)}' : 'Prêt à consulter',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                        fontSize: 11, color: scheme.onSurfaceVariant.withValues(alpha: 0.8)),
                  ),
                ],
              ),
            ),
            const SizedBox(width: 6),
            _actionIcon(Icons.open_in_new_rounded, 'Ouvrir',
                () => _smartOpen(doc, context),
                enabled: openable),
            _actionIcon(Icons.ios_share_outlined, 'Partager / télécharger',
                () => _downloadPdf(doc, context),
                enabled: openable),
            _actionIcon(Icons.delete_outline_rounded, 'Supprimer',
                () => _confirmDelete(doc, context)),
          ],
        ),
      ),
    );
  }

  Future<void> _confirmDelete(
      DocRef doc, BuildContext context) async {
    final messenger = ScaffoldMessenger.of(context);
    final scheme = Theme.of(context).colorScheme;
    final type = (doc.data()['type'] ?? 'cv').toString();
    final name = _safeName(doc.data());
    final label = _typeLabel(type);
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Supprimer ce document ?'),
        content: Text(
          '« $name » ($label) sera définitivement supprimé de l\'application (CV, lettre et PDF).',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Annuler'),
          ),
          FilledButton(
            style: FilledButton.styleFrom(
              backgroundColor: scheme.error,
              foregroundColor: scheme.onError,
            ),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Supprimer'),
          ),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await DbApi.deleteDoc(doc.id);
      await _reload(silent: true);
      messenger.showSnackBar(
        SnackBar(content: Text('« $name » supprimé'), behavior: SnackBarBehavior.floating),
      );
    } catch (e) {
      messenger.showSnackBar(
        const SnackBar(content: Text('Impossible de supprimer le document')),
      );
    }
  }

  Widget _actionIcon(IconData icon, String tooltip, VoidCallback onTap,
      {bool enabled = true}) {
    return IconButton(
      onPressed: enabled ? onTap : null,
      icon: Icon(icon, size: 17),
      tooltip: tooltip,
      visualDensity: VisualDensity.compact,
      padding: const EdgeInsets.all(4),
      constraints: const BoxConstraints(minWidth: 32, minHeight: 32),
    );
  }

  String _parseGroupTitle(Map<String, dynamic> d) {
    var name = (d['name'] ?? '').toString().trim();
    final sep = name.indexOf(' — ');
    if (sep >= 0) name = name.substring(sep + 3);
    final end = name.lastIndexOf(' (');
    if (end >= 0) name = name.substring(0, end);
    final t = name.trim();
    return t.isEmpty ? 'Offre' : t;
  }

  DateTime _groupTime(List<DocRef> docs) {
    var best = DateTime.fromMillisecondsSinceEpoch(0);
    for (final d in docs) {
      final t = timeToDate(d.data()['updatedAt']);
      if (t.isAfter(best)) best = t;
    }
    return best;
  }

  (String, Color, Color) _kindBadge(Map<String, dynamic> d) {
    if (d['original'] == true) return ('Originale', const Color(0xFF9A6700), const Color(0x1FEF6C00));
    if (d['kind'] == 'current') return ('À jour', const Color(0xFF2E7D32), const Color(0x1F2E7D32));
    return ('Adapté', const Color(0xFF1E3A5F), const Color(0x1F1E3A5F));
  }
}