const dotenv = require('dotenv');
const mongoose = require('mongoose');
const {
  formatReadinessReport,
  validateMongoIndexReadiness,
} = require('../utils/mongoIndexReadiness');

dotenv.config();

async function run({ logger = console } = {}) {
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI is required.');
  }

  await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false });

  const result = await validateMongoIndexReadiness();
  formatReadinessReport(result).forEach((line) => logger.log(line));

  if (!result.clean) {
    const error = new Error('Mongo index readiness validation failed.');
    error.code = 'MONGO_INDEX_READINESS_FAILED';
    error.readiness = result;
    throw error;
  }

  return result;
}

if (require.main === module) {
  run()
    .catch((error) => {
      if (error.code !== 'MONGO_INDEX_READINESS_FAILED') {
        console.error(error.message);
      }
      process.exitCode = 1;
    })
    .finally(async () => {
      await mongoose.disconnect().catch(() => {});
    });
}

module.exports = {
  run,
};
