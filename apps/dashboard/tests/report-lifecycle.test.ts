import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { dashboardServer } from '../src/server/index.js';
import { artifactPayload, readArtifacts } from '../src/server/readers/artifact-reader.js';
import { readReport } from '../src/server/readers/report-reader.js';
import { readWorkspace } from '../src/server/readers/workspace-reader.js';
import { digest } from '../src/server/security.js';
import { fixture, git, treeDigest } from './helpers.js';

test('report.json existence does not establish pending/draft/finalized lifecycle', async () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.workspace, '.astra/deliverables/report.json'), '{"report_meta":{},"findings":[]}');
    const ws = readWorkspace(f.root, f.name);
    const report = await readReport(ws, null);
    assert.equal(report.response.lifecycle.value, null);
    assert.equal(report.raw, null);
    const pending = { ...ws, report: { stage: 'pending' as const, renumber_failed_classes: [], partial_reasons: [] } };
    assert.equal((await readReport(pending, null)).response.lifecycle.value, 'pending');
    assert.equal((await readReport(pending, null)).raw, null);
  } finally {
    f.close();
  }
});
test('draft/finalized proof uses real Git commits; only sanitized report formats are published; reads leave workspace untouched', async () => {
  const f = fixture();
  try {
    const dir = path.join(f.workspace, '.astra/deliverables');
    git(dir, 'init');
    const reportBytes = `${JSON.stringify({ report_meta: { target: 'https://example.test/?token=private', assessment_date: '2026-10-08', scope: 'Test scope', executive_summary: 'API_KEY=private-report-key', exploit: false, coverage: { status: 'complete', limitations: [] } }, findings: [{ finding_id: 'INJ-01', title: 'Finding', severity: 'high', confidence: 'medium', proof_of_impact: 'Cookie: sid=private-report-cookie', raw_prompt: 'never publish' }], reconciliation_failed: [] }, null, 2)}\n`;
    const markdown = '# Assessment\nCookie: sid=private-markdown-cookie\n<script>private-script</script>\n';
    fs.writeFileSync(path.join(dir, 'report.json'), reportBytes);
    fs.writeFileSync(path.join(dir, 'comprehensive_security_assessment_report.md'), markdown);
    git(dir, 'add', '.');
    git(dir, 'commit', '-m', 'Model report checkpoint');
    const model = git(dir, 'rev-parse', 'HEAD').trim();
    const ws = readWorkspace(f.root, f.name);
    const draft = {
      ...ws,
      report: {
        stage: 'draft' as const,
        model_checkpoint: model,
        canonical_checkpoint: model,
        renumber_failed_classes: [],
        partial_reasons: [],
      },
    };
    const draftRead = await readReport(draft, null);
    assert.equal(draftRead.response.lifecycle.value, 'draft');
    assert.equal(draftRead.response.integrity, 'verified');
    const manifest = {
      schema_version: 1,
      input_fingerprint: 'b'.repeat(64),
      artifacts: {
        report_json: { path: 'report.json', disposition: 'committed', sha256: digest(reportBytes) },
        markdown: {
          path: 'comprehensive_security_assessment_report.md',
          disposition: 'committed',
          sha256: digest(markdown),
        },
        sarif: { path: 'report.sarif', disposition: 'absent' },
        pdf: { path: 'comprehensive_security_assessment_report.pdf', disposition: 'derived_uncommitted' },
      },
    };
    const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
    fs.writeFileSync(path.join(dir, 'report_finalization_manifest.json'), manifestBytes);
    git(dir, 'add', '.');
    git(dir, 'commit', '-m', 'Finalization checkpoint');
    const final = git(dir, 'rev-parse', 'HEAD').trim();
    const finalized = {
      ...ws,
      report: {
        stage: 'finalized' as const,
        model_checkpoint: model,
        canonical_checkpoint: model,
        final_checkpoint: final,
        finalization_manifest_sha256: digest(manifestBytes),
        sarif_disposition: 'absent' as const,
        renumber_failed_classes: [],
        partial_reasons: [],
      },
    };
    const before = treeDigest(f.workspace);
    const proof = await readReport(finalized, null);
    assert.equal(proof.response.integrity, 'verified');
    const artifacts = await readArtifacts(finalized, proof);
    const json = artifacts.response.artifacts.find((v) => v.filename === 'report.json');
    assert.ok(json);
    const published = artifactPayload(artifacts, json.artifactId).bytes.toString();
    assert.equal(published.includes('private-report-key'), false);
    assert.equal(published.includes('private-report-cookie'), false);
    assert.equal(published.includes('never publish'), false);
    assert.equal(proof.response.outputs.sarif?.status, 'not-applicable');
    assert.equal(proof.response.outputs.pdf?.download.available, false);
    assert.equal(treeDigest(f.workspace), before);
    Object.assign(f.session.durableScanState, { report: finalized.report });
    f.save();
    const apiBefore = treeDigest(f.workspace);
    const server = dashboardServer({ ...f.config, port: 0 }, async () => ({
      execution: null,
      health: 'unavailable',
      observedAt: null,
      reasonCode: 'TemporalUnavailable',
    }));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    try {
      const base = `http://127.0.0.1:${address.port}/api/scans/${f.name}`;
      const response = await fetch(`${base}/report`);
      assert.equal(response.status, 200);
      const body = (await response.json()) as {
        data: { lifecycle: { value: string }; outputs: { json: { download: { url: string } } } };
      };
      assert.equal(body.data.lifecycle.value, 'finalized');
      const download = await fetch(`http://127.0.0.1:${address.port}${body.data.outputs.json.download.url}`);
      assert.equal(download.status, 200);
      assert.equal((await download.text()).includes('private-report-'), false);
      assert.equal(treeDigest(f.workspace), apiBefore);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
    const corrupt = { ...finalized, report: { ...finalized.report, finalization_manifest_sha256: 'c'.repeat(64) } };
    assert.equal((await readReport(corrupt, null)).response.integrity, 'invalid');
  } finally {
    f.close();
  }
});
