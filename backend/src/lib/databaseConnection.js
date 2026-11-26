function sslOptionFor(env = process.env) {
  if (env.DATABASE_SSL !== 'verify-full') return false;
  const ca = typeof env.DATABASE_CA_CERT === 'string' && env.DATABASE_CA_CERT.trim()
    ? env.DATABASE_CA_CERT
    : undefined;
  return ca ? { rejectUnauthorized: true, ca } : { rejectUnauthorized: true };
}

function urlFor(role, env = process.env) {
  if (role === 'worker') return env.DATABASE_URL_WORKER || env.DATABASE_URL;
  if (role === 'migrator') return env.DATABASE_URL_MIGRATOR || env.DATABASE_URL;
  throw new TypeError('Unsupported database role.');
}

module.exports = { sslOptionFor, urlFor };
