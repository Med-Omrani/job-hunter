'use strict';
const redis = require('redis');
const url = process.env.REDIS_URL;
if (!url) throw new Error('REDIS_URL required');
const client = redis.createClient({ url });
client.on('error', (e) => console.error('redis error', e.message));
async function connect() { if (!client.isOpen) await client.connect(); }
module.exports = { client, connect };
