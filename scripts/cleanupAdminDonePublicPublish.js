const dotenv = require('dotenv');
const mongoose = require('mongoose');
const Project = require('../models/Project');

dotenv.config();

const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || 'https://apps.askfluid.now').replace(/\/+$/, '');

function parseArgs(argv) {
  const args = {
    apply: false,
    projectIds: [],
    limit: 50,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--apply') {
      args.apply = true;
    } else if (arg === '--project-id') {
      const projectId = argv[index + 1];
      index += 1;

      if (projectId) {
        args.projectIds.push(projectId);
      }
    } else if (arg === '--limit') {
      const limit = Number(argv[index + 1]);
      index += 1;

      if (Number.isInteger(limit) && limit > 0) {
        args.limit = Math.min(limit, 500);
      }
    }
  }

  return args;
}

function publicPublishCleanupUpdate() {
  return {
    isPublished: false,
    publish: false,
    publishedAt: null,
    'deploy.isPublished': false,
    'deploy.url': '',
    'deploy.publishedAt': null,
  };
}

async function listCandidates(limit) {
  return Project.find({
    isPublished: true,
    status: 'done',
    $or: [
      { generationStatus: 'done' },
      { generation_status: 'done' },
    ],
    'deploy.url': { $regex: `^${PUBLIC_BASE_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/p/` },
  })
    .sort({ updatedAt: -1, createdAt: -1 })
    .limit(limit)
    .select('_id userId name title slug isPublished publish publishedAt deploy status generationStatus generation_status latestPublishedBuildId updatedAt')
    .lean();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI is required.');
  }

  await mongoose.connect(process.env.MONGODB_URI);

  if (args.apply) {
    if (args.projectIds.length === 0) {
      throw new Error('Refusing to apply without at least one --project-id.');
    }

    const result = await Project.updateMany(
      {
        _id: { $in: args.projectIds },
      },
      {
        $set: publicPublishCleanupUpdate(),
      }
    );

    console.log(JSON.stringify({
      mode: 'apply',
      projectIds: args.projectIds,
      matchedCount: result.matchedCount,
      modifiedCount: result.modifiedCount,
    }, null, 2));
  } else {
    const candidates = await listCandidates(args.limit);

    console.log(JSON.stringify({
      mode: 'dry-run',
      note: 'Review candidates manually. Apply only to projects confirmed as admin-done and not user-published.',
      applyExample: 'node scripts/cleanupAdminDonePublicPublish.js --apply --project-id <id>',
      count: candidates.length,
      candidates,
    }, null, 2));
  }

  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error(error.stack || error.message || error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
