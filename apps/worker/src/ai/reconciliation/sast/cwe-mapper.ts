/** Deterministic bare-CWE routing into Astra's injection class. */

import type { ReconciliationClass } from '../../../types/reconciliation.js';
import type { Confidence, CWEMapping, AstraCategory } from './types.js';

export const CWE_TO_CATEGORY: Readonly<Record<string, CWEMapping>> = Object.freeze({
  'CWE-89': { category: 'INJECTION', name: 'SQL Injection', priority: 'P1' },
  'CWE-78': { category: 'INJECTION', name: 'OS Command Injection', priority: 'P1' },
  'CWE-95': { category: 'INJECTION', name: 'Code/Eval Injection', priority: 'P1' },
  'CWE-94': { category: 'INJECTION', name: 'Code Injection', priority: 'P1' },
  'CWE-502': { category: 'INJECTION', name: 'Deserialization', priority: 'P1' },
  'CWE-611': { category: 'INJECTION', name: 'XXE', priority: 'P1' },
  'CWE-22': { category: 'INJECTION', name: 'Path Traversal', priority: 'P1' },
  'CWE-434': { category: 'INJECTION', name: 'Unrestricted File Upload', priority: 'P1' },
  'CWE-943': { category: 'INJECTION', name: 'NoSQL Injection', priority: 'P1' },
  'CWE-93': { category: 'INJECTION', name: 'CRLF Injection', priority: 'P2' },
  'CWE-117': { category: 'INJECTION', name: 'Log Injection', priority: 'P2' },
  'CWE-470': { category: 'INJECTION', name: 'Unsafe Reflection', priority: 'P2' },
  'CWE-829': { category: 'INJECTION', name: 'Untrusted Function Inclusion', priority: 'P1' },
  'CWE-643': { category: 'INJECTION', name: 'XPath Injection', priority: 'P2' },
  'CWE-90': { category: 'INJECTION', name: 'LDAP Injection', priority: 'P2' },
  'CWE-91': { category: 'INJECTION', name: 'XML Injection', priority: 'P2' },
  'CWE-1336': { category: 'INJECTION', name: 'Template Injection', priority: 'P1' },
  'CWE-1427': { category: 'INJECTION', name: 'Prompt Injection', priority: 'P2' },
  'CWE-1321': { category: 'INJECTION', name: 'Prototype Pollution', priority: 'P1' },
  'CWE-548': { category: 'INJECTION', name: 'Directory Listing', priority: 'P3' },
});

export function vulnerabilityClassToCategory(vulnerabilityClass: ReconciliationClass): AstraCategory {
  const categories: Record<ReconciliationClass, AstraCategory> = {
    injection: 'INJECTION',
  };
  return categories[vulnerabilityClass];
}

export function normalizeConfidence(confidence: string | undefined): Confidence | undefined {
  if (confidence === undefined) return undefined;
  const normalized = confidence.toLowerCase();
  if (normalized === 'med' || normalized === 'medium') return 'medium';
  if (normalized === 'high' || normalized === 'low') return normalized;
  return undefined;
}
