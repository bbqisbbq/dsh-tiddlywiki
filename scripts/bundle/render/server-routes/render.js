/*\
title: $:/plugins/dsh/render/server-routes/render.js
type: application/javascript
module-type: route

POST /render — native TiddlyWiki → HTML fragment for the DSH reply stream

Body (JSON in state.data):
  { title }                       render an existing tiddler's wikified body
  { text, contextTitle?, parseAsInline? }
                                  render arbitrary wiki text as a fragment
\*/
"use strict";

/*
The fragment's internal wiki links are rewritten to the SAME-ORIGIN DSH proxy
hash (`/dsh-tiddlywiki/tw/#<title>`) by overriding the `tv-wikilink-template`
variable while rendering. Verified against tiddlywiki 5.4.1's link widget:
`link.js` expands `$uri_encoded$` (encodeURIComponentExtended) into the href,
so the default `#Title` becomes `/dsh-tiddlywiki/tw/#Title`. The DSH page's
document-level click interceptor + the embedded TW's hash navigation
(story.js reads the hash via decodeURIComponentSafe) both handle that href —
no post-hoc string rewriting needed.
*/
var WIKILINK_TEMPLATE = "/dsh-tiddlywiki/tw/#$uri_encoded$";

exports.methods = ["POST"];

exports.path = /^\/render$/;

exports.info = {
	priority: 100
};

function sendJson(response,status,payload) {
	response.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"});
	response.end(JSON.stringify(payload));
}

exports.handler = function(request,response,state) {
	var body;
	try {
		body = JSON.parse(state.data || "{}");
	} catch(e) {
		sendJson(response,400,{ok:false,error:"invalid JSON body"});
		return;
	}
	try {
		var variables = {
			"tv-wikilink-template": WIKILINK_TEMPLATE
		};
		if(typeof body.title === "string" && body.title.length > 0) {
			// Render an existing tiddler's wikified body (block parse, so
			// headings / tables / lists render natively).
			var tiddler = state.wiki.getTiddler(body.title);
			if(!tiddler) {
				sendJson(response,404,{ok:false,notFound:true,title:body.title});
				return;
			}
			variables.currentTiddler = body.title;
			var html = state.wiki.renderText("text/html","text/vnd.tiddlywiki",tiddler.fields.text,{
				parseAsInline: false,
				variables: variables
			});
			response.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store"});
			response.end(html);
			return;
		}
		if(typeof body.text === "string") {
			// Render arbitrary wiki text (contextTitle gives currentTiddler so
			// links/transclusions resolve in that tiddler's context).
			if(typeof body.contextTitle === "string" && body.contextTitle.length > 0) {
				variables.currentTiddler = body.contextTitle;
			}
			var inline = body.parseAsInline === true;
			var textHtml = state.wiki.renderText("text/html","text/vnd.tiddlywiki",body.text,{
				parseAsInline: inline,
				variables: variables
			});
			response.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store"});
			response.end(textHtml);
			return;
		}
		sendJson(response,400,{ok:false,error:"body must provide \"title\" or \"text\""});
	} catch(e) {
		sendJson(response,500,{ok:false,error:String((e && e.message) || e)});
	}
};
