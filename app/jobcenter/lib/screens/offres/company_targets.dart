// Watch-list of target employers, moved out of offers_screen.dart (2026-09-25).
// `pinned` groups sort first; the rest are ordered by offer count at runtime.

class CompanyTarget {
  final String label;
  final List<String> sourceIds;
  final List<String> aliases;
  final bool pinned;
  const CompanyTarget(
    this.label, {
    this.sourceIds = const [],
    this.aliases = const [],
    this.pinned = false,
  });
}

const companyTargets = <CompanyTarget>[
  CompanyTarget('Capgemini Engineering',
      sourceIds: ['capgemini-tn', 'capgemini-fr'],
      aliases: ['capgemini engineering'],
      pinned: true),
  CompanyTarget('Sagemcom', sourceIds: ['sagemcom'], aliases: ['sagemcom'], pinned: true),
  CompanyTarget('STMicroelectronics',
      sourceIds: ['stmicro', 'eightfold-stmicroelectronics'],
      aliases: ['sto', 'stmicro'],
      pinned: true),
  CompanyTarget('Airbus',
      sourceIds: ['airbus', 'workday-ag'], aliases: ['airbus'], pinned: true),
  CompanyTarget('Talan', sourceIds: ['talan'], aliases: ['talan'], pinned: true),

  CompanyTarget('Air Liquide', aliases: ['air liquide']),
  CompanyTarget('Valeo', sourceIds: ['workday-valeo'], aliases: ['valeo']),
  CompanyTarget('Scalian', aliases: ['scalian']),
  CompanyTarget('Inetum', aliases: ['inetum']),
  CompanyTarget('Expleo', aliases: ['expleo']),
  CompanyTarget('SOCOMEC', aliases: ['socomec']),
  CompanyTarget('Leoni Tunisia', aliases: ['leoni']),
  CompanyTarget('Caveo Automotive', aliases: ['caveo']),
  CompanyTarget('Visteon', aliases: ['visteon']),
  CompanyTarget('Harmattan AI', aliases: ['harmattan']),

  CompanyTarget('Bosch', aliases: ['bosch']),
  CompanyTarget('Siemens', aliases: ['siemens']),
  CompanyTarget('Schneider Electric', aliases: ['schneider']),
  CompanyTarget('Thales', sourceIds: ['smartrecruiters-thales'], aliases: ['thales']),
  CompanyTarget('Safran', aliases: ['safran']),
  CompanyTarget('Alstom', aliases: ['alstom']),
  CompanyTarget('Renault', aliases: ['renault']),
  CompanyTarget('Stellantis', aliases: ['stellantis']),
  CompanyTarget('Segula Technologies', aliases: ['segula']),
  CompanyTarget('Altran', aliases: ['altran']),
  CompanyTarget('Alten', sourceIds: ['smartrecruiters-alten'], aliases: ['alten']),
  CompanyTarget('Assystem',
      sourceIds: ['smartrecruiters-assystem'], aliases: ['assystem']),
  CompanyTarget('Sopra Steria', aliases: ['sopra steria']),
  CompanyTarget('Atos', aliases: ['atos']),
  CompanyTarget('Worldline', aliases: ['worldline']),
  CompanyTarget('Vermeg', aliases: ['vermeg']),
  CompanyTarget('Sofrecom Tunisia', aliases: ['sofrecom']),
  CompanyTarget('Telnet', aliases: ['telnet']),
  CompanyTarget('DXC Technology', aliases: ['dxc']),

  // Tunisian employers added 2026-09-30 from the TN dossier and live TN
  // postings. No board yet for these four, so they match on company name only.
  CompanyTarget('IHM', aliases: ['ihm']),
  CompanyTarget('Actia', aliases: ['actia']),
  CompanyTarget('Ooredoo', aliases: ['ooredoo']),
  CompanyTarget('Tunisie Telecom', aliases: ['tunisie telecom', 'tunisietelecom']),
  CompanyTarget('Poulina Group Holding',
      aliases: ['poulina', 'poulina group']),
  CompanyTarget('SIMEF', aliases: ['simef']),
];

const priorityCountries = <String>['Tunisie', 'Allemagne', 'France', 'Canada'];

/// Human label for a source id, with a readable fallback for new sources.
String sourceLabel(String sid) {
  const map = {
    'capgemini-tn': 'Capgemini',
    'capgemini-fr': 'Capgemini FR',
    'sagemcom': 'Sagemcom',
    'stmicro': 'STMicro',
    'talan': 'Talan',
    'airbus': 'Airbus',
    'thales': 'Thales',
    'eightfold-stmicroelectronics': 'STMicro',
    'workday-ag': 'Airbus',
    'workday-valeo': 'Valeo',
    'smartrecruiters-alten': 'Alten',
    'smartrecruiters-assystem': 'Assystem',
    'smartrecruiters-thales': 'Thales',
    'nxp': 'NXP',
    'continental': 'Continental',
    'keejob': 'Keejob',
    'jobijoba': 'Jobijoba',
    'linkedin': 'LinkedIn',
    'tanitjobs': 'TanitJobs',
    'tunisiejob': 'TunisieJob',
    'experteer': 'Experteer',
    'remotive': 'Remotive',
    'remoteok': 'RemoteOK',
    'manual': 'Ajout manuel',
  };
  if (map.containsKey(sid)) return map[sid]!;
  return sid
      .split(RegExp(r'[-_]'))
      .where((w) => w.isNotEmpty)
      .map((w) => w[0].toUpperCase() + w.substring(1))
      .join(' ');
}
