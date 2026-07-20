console.error(
  [
    'scripts/promoteAdmin.js is retired.',
    'Admin access now uses AdminUser/AdminSession, separate from public User accounts.',
    'Use: ADMIN_BOOTSTRAP_PASSWORD="long random password" node scripts/createAdminUser.js --email operator@example.com --confirm CREATE_ADMIN_USER',
  ].join('\n')
);
process.exitCode = 1;
