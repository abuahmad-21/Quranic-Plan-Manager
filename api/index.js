const path = require('path');
const http = require('http');
const orig = http.createServer.bind(http);
let handler;
function getHandler() {
  if (handler) return handler;
  http.createServer = fn => { handler = fn; return { listen:()=>{}, on:()=>({listen:()=>{}}), close:()=>{} }; };
  process.chdir(path.join(__dirname, '..', 'quran-coach'));
  require('../quran-coach/server.js');
  http.createServer = orig;
  return handler;
}
module.exports = (req, res) => {
  const fn = getHandler();
  if (fn) return fn(req, res);
  res.statusCode = 500;
  res.end('{"error":"not initialized"}');
};
