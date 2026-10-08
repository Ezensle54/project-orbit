'use strict';

const requiredEnvironment = ['DATABASE_URL', 'SESSION_SECRET', 'ABLY_API_KEY'];
const missingEnvironment = requiredEnvironment.filter((name) => !process.env[name]);
const invalidSessionSecret = Boolean(process.env.SESSION_SECRET) && process.env.SESSION_SECRET.length < 32;

if (missingEnvironment.length || invalidSessionSecret) {
  module.exports = (req, res) => {
    const details = missingEnvironment.length
      ? `Missing Vercel environment variables: ${missingEnvironment.join(', ')}.`
      : 'SESSION_SECRET must contain at least 32 characters.';
    res.statusCode = 503;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({
      error: `${details} Set these in Vercel Project Settings > Environment Variables, then redeploy.`
    }));
  };
} else {
  const app = require('../api.js');

  module.exports = (req, res) => {
    const url = req.url || '/';
    if (url !== '/api' && !url.startsWith('/api/')) {
      req.url = `/api${url.startsWith('/') ? url : `/${url}`}`;
    }
    return app(req, res);
  };
}
