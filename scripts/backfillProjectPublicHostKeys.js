const dotenv = require('dotenv');
const mongoose = require('mongoose');
const {
  backfillProjectPublicHostKeys,
} = require('../utils/projectPublicHostKeyBackfill');

dotenv.config();

function parseArgs(argv = process.argv.slice(2)) {
  return {
    apply: argv.includes('--apply'),
    help: argv.includes('--help') || argv.includes('-h'),
  };
}

function usage(logger = console) {
  logger.log(
    [
      'Usage:',
      '  node scripts/backfillProjectPublicHostKeys.js',
      '  node scripts/backfillProjectPublicHostKeys.js --apply',
      '',
      'Default mode is dry-run and makes no changes.',
      '--apply assigns publicHostKey only to legacy projects where the field is missing, null, or empty.',
      'Existing valid publicHostKey values are never changed.',
      'Malformed or duplicate existing values block apply and require operator remediation.',
    ].join('\n')
  );
}

function formatSummary(result) {
  const lines = [
    `Mode: ${result.apply ? 'apply' : 'dry-run'}`,
    `Total projects inspected: ${result.totalProjectsInspected}`,
    `Already valid publicHostKey: ${result.alreadyValid}`,
    `Missing/unset publicHostKey: ${result.missingUnset}`,
    `Invalid existing publicHostKey: ${result.invalidExisting}`,
    `Duplicate publicHostKey values: ${result.duplicateValueCount}`,
    `Duplicate project references: ${result.duplicateDocumentCount}`,
    `Would update: ${result.wouldUpdate}`,
    `Updated: ${result.updated}`,
    `Concurrent already updated: ${result.concurrentAlreadyUpdated}`,
    `Conditional update matched: ${result.conditionalUpdateMatched}`,
    `Conditional update modified: ${result.conditionalUpdateModified}`,
    `Conditional update zero-match: ${result.conditionalUpdateZeroMatched}`,
    `Conflicts: ${result.conflicts.length}`,
    `Errors: ${result.errors.length}`,
    `Generated-key collision retries: ${result.collisionRetries}`,
  ];

  if (result.initial.invalidValues?.length) {
    lines.push('Invalid existing values require manual remediation before apply:');
    for (const invalid of result.initial.invalidValues.slice(0, 20)) {
      lines.push(`  project=${invalid.projectId} reason=${invalid.reason} type=${invalid.valueType}`);
    }
  }

  if (result.initial.duplicateKeys?.length) {
    lines.push('Duplicate existing publicHostKey values require manual remediation before apply:');
    for (const duplicate of result.initial.duplicateKeys.slice(0, 20)) {
      lines.push(`  key=${duplicate.publicHostKey} count=${duplicate.count} projects=${duplicate.projectIds.join(',')}`);
    }
  }

  if (!result.apply) {
    lines.push('No changes made. Re-run with --apply in a controlled maintenance window to backfill missing keys.');
  }

  if (result.conflicts?.length) {
    lines.push('Conflict diagnostics:');
    for (const conflict of result.conflicts.slice(0, 20)) {
      lines.push(
        [
          `  project=${conflict.projectId}`,
          `reason=${conflict.reason || conflict.action}`,
          `updateMatched=${conflict.updateMatchedCount ?? 'unknown'}`,
          `updateModified=${conflict.updateModifiedCount ?? 'unknown'}`,
          `rereadFound=${conflict.rereadFound ?? 'unknown'}`,
          `currentState=${conflict.currentState || conflict.rereadState || 'unknown'}`,
          conflict.currentReason ? `currentReason=${conflict.currentReason}` : null,
          conflict.currentValueType ? `currentType=${conflict.currentValueType}` : null,
        ].filter(Boolean).join(' ')
      );
    }
  }

  if (result.errors?.length) {
    lines.push('Update error diagnostics:');
    for (const error of result.errors.slice(0, 20)) {
      lines.push(`  project=${error.projectId} stage=${error.stage} code=${error.code} message=${error.message}`);
    }
  }

  return lines;
}

async function run({ argv = process.argv.slice(2), logger = console } = {}) {
  const args = parseArgs(argv);

  if (args.help) {
    usage(logger);
    return null;
  }

  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI is required.');
  }

  await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false });

  const result = await backfillProjectPublicHostKeys({ apply: args.apply });
  formatSummary(result).forEach((line) => logger.log(line));
  return result;
}

if (require.main === module) {
  run()
    .catch((error) => {
      console.error(error.message);

      const result = error.result || error.summary;
      if (result) {
        formatSummary(result).forEach((line) => console.error(line));
      }

      process.exitCode = 1;
    })
    .finally(async () => {
      await mongoose.disconnect().catch(() => {});
    });
}

module.exports = {
  formatSummary,
  parseArgs,
  run,
  usage,
};
