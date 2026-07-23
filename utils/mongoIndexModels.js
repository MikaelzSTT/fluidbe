const AdminAuditLog = require('../models/AdminAuditLog');
const AdminSession = require('../models/AdminSession');
const AdminUser = require('../models/AdminUser');
const BriefingSession = require('../models/BriefingSession');
const BuildJob = require('../models/BuildJob');
const ChatMessage = require('../models/ChatMessage');
const ConnectorSecret = require('../models/ConnectorSecret');
const Project = require('../models/Project');
const ProjectBuild = require('../models/ProjectBuild');
const ProjectChangeRequest = require('../models/ProjectChangeRequest');
const ProjectMessage = require('../models/ProjectMessage');
const RuntimeDocument = require('../models/RuntimeDocument');
const Session = require('../models/Session');
const StripeWebhookEvent = require('../models/StripeWebhookEvent');
const User = require('../models/User');

const MONGO_INDEX_MODELS = [
  AdminAuditLog,
  AdminSession,
  AdminUser,
  BriefingSession,
  BuildJob,
  ChatMessage,
  ConnectorSecret,
  Project,
  ProjectBuild,
  ProjectChangeRequest,
  ProjectMessage,
  RuntimeDocument,
  Session,
  StripeWebhookEvent,
  User,
];

module.exports = {
  MONGO_INDEX_MODELS,
};
