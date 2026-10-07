'use strict';

const app = require('../api.js');

module.exports = (req, res) => {
  const url = req.url || '/';
  if (url !== '/api' && !url.startsWith('/api/')) {
    req.url = `/api${url.startsWith('/') ? url : `/${url}`}`;
  }
  return app(req, res);
};
