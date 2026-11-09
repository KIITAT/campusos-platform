/**
 * Codes from Protean's published file formats for the TDS statements of tax
 * year 2026-27 onwards (P1-05d, ACC-31): Form 140 (was 26Q) and Form 144 (was
 * 27Q), version 1.2 of 22 July 2026. Copied from the annexures; a new version of
 * the formats is a change here.
 */

/** Form 140, Annexure 2: section codes to be used in the return. */
export const FORM_140_SECTION_CODES: readonly string[] = [
  '1004', '1005', '1006', '1008', '1009', '1011', '1012', '1013', '1014', '1015', '1016', '1017', '1018', '1019',
  '1020', '1021', '1022', '1023', '1024', '1026', '1027', '1028', '1029', '1030', '1031', '1033', '1034', '1035',
  '1037', '1038', '1058', '1059', '1060', '1061', '1062', '1063', '1064', '1065', '1066', '1067',
]

/** Form 144, Annexure 2: section codes to be used in the return. */
export const FORM_144_SECTION_CODES: readonly string[] = [
  '1004', '1039', '1040', '1041', '1042', '1043', '1044', '1045', '1046', '1047', '1048', '1049', '1050', '1051',
  '1052', '1053', '1054', '1055', '1056', '1057', '1058', '1059', '1060', '1061', '1062', '1063', '1064', '1065',
  '1066', '1067',
]

const CAPITAL_GAINS = ['66', '67', '68', '69', '70']

/**
 * Form 144, Annexure 9: for these sections the deductee record must name a
 * nature of remittance, one of the codes listed against the section.
 */
export const FORM_144_REMITTANCE: Readonly<Record<string, readonly string[]>> = {
  '1040': ['27'],
  '1041': ['27'],
  '1042': ['27'],
  '1043': ['27'],
  '1044': ['27'],
  '1045': ['27'],
  '1046': ['16', '73'],
  '1048': ['27', '16', '73', ...CAPITAL_GAINS],
  '1049': ['27', '16', '73', ...CAPITAL_GAINS],
  '1050': ['27', '16', '73', ...CAPITAL_GAINS],
  '1051': ['27', '16', '73'],
  '1052': ['71'],
  '1053': ['27', '16', '73'],
  '1054': ['72'],
  '1055': ['27', '16', '73', ...CAPITAL_GAINS],
  '1056': ['27', '16', '73', ...CAPITAL_GAINS],
  '1057': ['27', '73', '16', '28', ...CAPITAL_GAINS, '21', '74', '49', '75', '99'],
}

/** Annexure 1: the return's state codes. Not the GST codes (Delhi is 07 for GST, 09 here). */
export const TDS_STATE_CODES: readonly string[] = [
  '01', '02', '03', '04', '05', '06', '07', '09', '10', '11', '12', '13', '14', '15', '16', '17', '18', '19', '20',
  '21', '22', '23', '24', '25', '26', '27', '28', '29', '30', '31', '32', '33', '34', '35', '36', '37',
]

/** Annexure 4: deductor categories. */
export const TDS_DEDUCTOR_TYPES = ['A', 'S', 'D', 'E', 'G', 'H', 'L', 'N', 'K', 'M', 'P', 'T', 'J', 'B', 'Q', 'F'] as const
