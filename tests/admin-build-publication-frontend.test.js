const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const adminHtmlPath = path.join(__dirname, '..', 'public', 'admin.html');

function readAdminHtml() {
  return fs.readFileSync(adminHtmlPath, 'utf8');
}

test('Admin React/Vite done shortcut publishes the exact reviewed build', () => {
  const html = readAdminHtml();
  const handleDone = html.match(/function handleDone\(\) \{[\s\S]*?\n      \}/);

  assert.ok(handleDone, 'handleDone function should exist.');
  assert.match(
    handleDone[0],
    /if \(isReactVitePublishingFlow\(\)\) \{\s*return publishReviewedReactViteBuildAsDone\(\);\s*\}/
  );
  assert.match(
    html,
    /\/api\/admin\/projects\/\$\{encodeURIComponent\(projectId\)\}\/builds\/\$\{encodeURIComponent\(buildId\)\}\/publish/
  );
  assert.match(html, /isCurrentReviewedBuild\(projectId, buildId\)/);
});

test('Admin current build state is scoped to the selected project', () => {
  const html = readAdminHtml();

  assert.match(html, /let currentBuildProjectId = '';/);
  assert.match(html, /function setCurrentReactViteBuild\(\{ previewUrl = '', distUrl = '', buildId = '', projectId = '' \} = \{\}\)/);
  assert.match(html, /String\(normalizedProjectId\) !== String\(selectedProjectId\)/);
  assert.match(html, /currentBuildProjectId = normalizedProjectId;/);
  assert.match(html, /currentBuildProjectId = '';/);
});

test('Admin import results from an old project are ignored before touching preview state', () => {
  const html = readAdminHtml();
  const applyImport = html.match(/async function applyReactViteImportResult\(result, requestProjectId, options = \{\}\) \{[\s\S]*?\n      \}/);

  assert.ok(applyImport, 'applyReactViteImportResult function should exist.');
  assert.match(applyImport[0], /const normalizedRequestProjectId = normalizeAdminIdValue\(requestProjectId\);/);
  assert.match(applyImport[0], /String\(selectedProjectId\) !== String\(normalizedRequestProjectId\)/);
  assert.match(applyImport[0], /return \{ ignored: true, stale: true \};/);
  assert.match(applyImport[0], /setCurrentReactViteBuild\(\{\s*projectId: normalizedRequestProjectId,/);
});

test('Admin preview identity is checked before publishing', () => {
  const html = readAdminHtml();

  assert.match(html, /function getBuildIdentityFromPreviewUrl\(value\)/);
  assert.match(html, /function isCurrentReviewedBuild\(projectId, buildId, previewUrl = currentPreviewUrl\)/);
  assert.match(html, /String\(previewIdentity\.projectId\) === String\(normalizedProjectId\)/);
  assert.match(html, /String\(previewIdentity\.buildId\) === String\(normalizedBuildId\)/);
  assert.match(html, /Preview ignorado porque pertence a outro projeto\/build\./);
});

test('Admin upload errors safely handle HTML responses and keep stale preview state', () => {
  const html = readAdminHtml();

  assert.match(
    html,
    /async function readAdminAuthResponse\(res\) \{[\s\S]*?return await readResponseSafely\(res\);/
  );
  assert.match(html, /return getResponseErrorMessage\(data, fallback\);/);
  assert.match(html, /const statusPrefix = status \? `HTTP \$\{status\}: ` : '';/);
  assert.match(html, /new Error\(`\$\{statusPrefix\}\$\{message \|\| fallback\}`\)/);
  assert.match(html, /function getRetainedReactVitePreviewLabel\(\)/);
  assert.match(html, /Preview atual mantido como antigo\/stale/);
  assert.match(html, /Nenhum novo preview foi aplicado\./);
  assert.match(
    html,
    /setAdminStatus\(`Erro: \$\{normalizedError\.message\} \$\{getRetainedReactVitePreviewLabel\(\)\}`\);/
  );
});
