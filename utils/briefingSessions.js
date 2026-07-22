const mongoose = require('mongoose');
const BriefingSession = require('../models/BriefingSession');

const BRIEFING_SESSION_EXPIRED_CODE = 'BRIEFING_SESSION_EXPIRED';
const DEFAULT_BRIEFING_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MIN_BRIEFING_SESSION_TTL_MS = 15 * 60 * 1000;

function getBriefingSessionTtlMs() {
  const configured = Number.parseInt(process.env.BRIEFING_SESSION_TTL_MS || '', 10);

  if (!Number.isFinite(configured) || configured < MIN_BRIEFING_SESSION_TTL_MS) {
    return DEFAULT_BRIEFING_SESSION_TTL_MS;
  }

  return configured;
}

function getConversationId(req) {
  return String(req.session?._id || req.session?.id || req.session?.jti || req.userId || '').trim();
}

function getRequestedBriefingSessionId(body = {}) {
  return String(body.briefingSessionId || body.briefing_session_id || '').trim();
}

function normalizeProjectFlow(body = {}) {
  return String(body.projectFlow || body.project_flow || body.flow || '').trim().toLowerCase();
}

function isNewProjectFlow(body = {}) {
  return ['new', 'new_project', 'create', 'create_project', 'creation'].includes(normalizeProjectFlow(body));
}

function isExistingProjectFlow(body = {}) {
  return ['existing', 'existing_project', 'edit', 'inspect', 'inspection'].includes(normalizeProjectFlow(body));
}

function isBuildProjectAction(body = {}, message = body.message) {
  const action = String(body.action || body.intent || '').trim().toLowerCase();
  if (['build_project', 'create_project', 'confirm_build'].includes(action)) {
    return true;
  }

  const normalizedMessage = String(message || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[!?.,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return /^(?:construir|criar|gerar|montar)(?: o)? projeto(?: agora)?$/.test(normalizedMessage);
}

function isExpired(session, now = new Date()) {
  return !session?.expiresAt || new Date(session.expiresAt).getTime() <= now.getTime();
}

function buildBriefingSessionPayload(session) {
  if (!session) return null;

  return {
    briefingSessionId: String(session._id),
    briefing: session.briefing || {},
    briefingSummary: session.briefingSummary || {},
    briefingComplete: Boolean(session.complete),
    canBuild: Boolean(session.canBuild),
    expiresAt: session.expiresAt,
    projectId: session.projectId ? String(session.projectId) : null,
  };
}

function sendBriefingSessionExpired(res) {
  return res.status(409).json({
    code: BRIEFING_SESSION_EXPIRED_CODE,
    message: 'O briefing salvo expirou ou ficou inconsistente. Recarregue o briefing antes de construir.',
    restoreRequired: true,
    restoreEndpoint: '/api/chat/briefing',
  });
}

async function findBriefingSession(req, { includeCompleted = true } = {}) {
  const requestInput = {
    ...(req.query || {}),
    ...(req.body || {}),
  };
  const requestedId = getRequestedBriefingSessionId(requestInput);
  const query = { userId: req.userId };

  if (requestedId) {
    if (!mongoose.Types.ObjectId.isValid(requestedId)) return null;
    query._id = requestedId;
  } else {
    const conversationId = getConversationId(req);
    if (!conversationId) return null;
    query.conversationId = conversationId;
  }

  if (!includeCompleted) {
    query.status = 'active';
    query.expiresAt = { $gt: new Date() };
  }

  const lookup = BriefingSession.findOne(query);
  if (!requestedId && typeof lookup.sort === 'function') {
    lookup.sort({ updatedAt: -1, _id: -1 });
  }
  if (typeof lookup.lean === 'function') return lookup.lean();
  return lookup;
}

async function persistBriefingSession(req, evaluation, {
  sourcePrompt = '',
  structuredAnswers = {},
  startNew = false,
} = {}) {
  const conversationId = getConversationId(req);
  if (!conversationId) return null;

  const now = new Date();
  const expiresAt = new Date(now.getTime() + getBriefingSessionTtlMs());
  const sessionData = {
    userId: req.userId,
    conversationId,
    status: 'active',
    briefing: evaluation.briefing,
    briefingSummary: evaluation.briefingSummary,
    structuredAnswers,
    complete: Boolean(evaluation.complete),
    canBuild: Boolean(evaluation.complete),
    expiresAt,
    projectId: null,
    completedAt: null,
  };
  if (sourcePrompt) sessionData.sourcePrompt = sourcePrompt;
  const requestedId = getRequestedBriefingSessionId(req.body || {});

  if (!startNew) {
    const query = {
      userId: req.userId,
      conversationId,
      status: 'active',
      expiresAt: { $gt: now },
    };
    if (requestedId && mongoose.Types.ObjectId.isValid(requestedId)) query._id = requestedId;

    const existing = await BriefingSession.findOneAndUpdate(
      query,
      { $set: sessionData },
      { new: true, runValidators: true }
    );
    if (existing) return existing;
  }

  return BriefingSession.create(sessionData);
}

module.exports = {
  BRIEFING_SESSION_EXPIRED_CODE,
  buildBriefingSessionPayload,
  findBriefingSession,
  getBriefingSessionTtlMs,
  getConversationId,
  getRequestedBriefingSessionId,
  isBuildProjectAction,
  isExistingProjectFlow,
  isExpired,
  isNewProjectFlow,
  persistBriefingSession,
  sendBriefingSessionExpired,
};
