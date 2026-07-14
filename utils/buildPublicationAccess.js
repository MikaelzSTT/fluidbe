function getBuildIdentityFromUrl(value) {
  if (typeof value !== 'string' || !value) {
    return null;
  }

  let pathname;

  try {
    pathname = decodeURIComponent(new URL(value, 'http://localhost').pathname);
  } catch (error) {
    return null;
  }

  if (!pathname.startsWith('/builds/')) {
    return null;
  }

  const parts = pathname.slice('/builds/'.length).split('/').filter(Boolean);

  if (parts.length < 2) {
    return null;
  }

  return {
    projectId: parts[0],
    buildKey: parts[1],
    indexBuildUrl: `/builds/${parts[0]}/${parts[1]}/index.html`,
  };
}

function idsEqual(left, right) {
  if (!left || !right) {
    return false;
  }

  const leftId = left._id || left;
  const rightId = right._id || right;
  return String(leftId) === String(rightId);
}

function isProjectBuildExplicitlyPublished(project, build) {
  if (!project || !build || project.isPublished !== true) {
    return false;
  }

  if (build.status === 'done' && idsEqual(project.latestPublishedBuildId, build._id)) {
    return true;
  }

  return false;
}

module.exports = {
  getBuildIdentityFromUrl,
  isProjectBuildExplicitlyPublished,
};
