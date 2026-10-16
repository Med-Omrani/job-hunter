DateTime timeToDate(dynamic t) {
  if (t == null) return DateTime.now();
  if (t is DateTime) return t;
  if (t is String) {
    final d = DateTime.tryParse(t);
    if (d != null) return d;
  }
  if (t is num) {
    if (t > 10000000000) return DateTime.fromMillisecondsSinceEpoch(t.toInt());
    return DateTime.fromMillisecondsSinceEpoch(t.toInt() * 1000);
  }
  if (t is Map && t.containsKey('_seconds')) {
    return DateTime.fromMillisecondsSinceEpoch(
        (t['_seconds'] as num).toInt() * 1000);
  }
  return DateTime.now();
}

String timeAgo(dynamic t, {bool short = false}) {
  final local = timeToDate(t).toLocal();
  final now = DateTime.now();
  final diff = now.difference(local);
  if (diff.isNegative || diff.inSeconds < 45) return 'à l’instant';
  if (diff.inMinutes < 60) {
    final m = diff.inMinutes;
    return short ? '$m min' : 'il y a $m ${m == 1 ? 'minute' : 'minutes'}';
  }
  if (diff.inHours < 24) {
    final h = diff.inHours;
    return short ? '$h h' : 'il y a $h ${h == 1 ? 'heure' : 'heures'}';
  }
  if (diff.inDays < 7) {
    if (diff.inDays == 1) return 'hier';
    final d = diff.inDays;
    return short ? '$d j' : 'il y a $d jours';
  }
  final mo = local.month.toString().padLeft(2, '0');
  return '${local.day.toString().padLeft(2, '0')}/$mo/${local.year}';
}

String fmtTime(dynamic t) {
  final local = timeToDate(t).toLocal();
  final hh = local.hour.toString().padLeft(2, '0');
  final mi = local.minute.toString().padLeft(2, '0');
  return '$hh:$mi';
}

String fmtFull(dynamic t) {
  final local = timeToDate(t).toLocal();
  final dd = local.day.toString().padLeft(2, '0');
  final mo = local.month.toString().padLeft(2, '0');
  final hh = local.hour.toString().padLeft(2, '0');
  final mi = local.minute.toString().padLeft(2, '0');
  return '$dd/$mo/${local.year} $hh:$mi';
}