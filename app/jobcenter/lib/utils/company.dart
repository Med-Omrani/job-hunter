String cleanCompany(dynamic raw) {
  var s = (raw ?? '').toString().trim();
  if (s.isEmpty || s.toLowerCase() == 'null') return '';

  final a = RegExp(r'>\s*([^<>]+?)\s*</a>', caseSensitive: false).firstMatch(s);
  if (a != null) s = a.group(1)!.trim();

  final alt =
      RegExp(r'alt="\s*([^"]+?)\s*logo\s*"', caseSensitive: false).firstMatch(s);
  if (alt != null) s = alt.group(1)!.trim();

  s = s.replaceAll(RegExp(r'<[^>]*>'), ' ');
  s = s
      .replaceAll('&amp;', '&')
      .replaceAll('&#x27;', '\'')
      .replaceAll('&quot;', '"')
      .replaceAll(RegExp(r'\s+'), ' ')
      .trim();
  s = s
      .replaceAll(RegExp(r'^\s*(logo|image|photo|recruteur)\b', caseSensitive: false), '')
      .trim();
  return s;
}

String companyKey(String name) => name.toLowerCase().trim();

String shortCompany(String name, {int max = 18}) {
  if (name.length <= max) return name;
  return '${name.substring(0, max).trim()}…';
}