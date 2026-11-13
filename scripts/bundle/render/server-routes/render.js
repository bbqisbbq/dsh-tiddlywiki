/*\
title: $:/plugins/dsh/render/server-routes/render.js
type: application/javascript
module-type: route

POST /render — native TiddlyWiki → HTML fragment for the DSH reply stream

Body (JSON in state.data):
  { title }                       render an existing tiddler's body with ITS type
  { text, type?, contextTitle?, parseAsInline? }
                                  render arbitrary content as a fragment
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

/*
The host route blocks the plugin's secret namespace by title, but a TW filter
can split a title into pieces and join it again (verified: `[[$:]] [[/plugins/
dsh-tiddlywiki/config]] +[join[]]` rendered the config JSON). The final
boundary must therefore be inside the renderer: while rendering one fragment,
hide every title under the plugin namespace from `getTiddler`/`getTiddlerText`.
The patch is synchronous and restored in `finally`, so no other request can
observe it.
*/
var BLOCKED_TITLE_PREFIX = "$:/plugins/dsh-tiddlywiki/";

function isBlockedTitle(title) {
	return typeof title === "string" && title.indexOf(BLOCKED_TITLE_PREFIX) === 0;
}

function renderWithoutBlockedTitles(wiki, render) {
	var originalGetTiddler = wiki.getTiddler;
	var originalGetTiddlerText = wiki.getTiddlerText;
	wiki.getTiddler = function(title) {
		if(isBlockedTitle(title)) {
			return undefined;
		}
		return originalGetTiddler.apply(wiki,arguments);
	};
	wiki.getTiddlerText = function(title) {
		if(isBlockedTitle(title)) {
			return arguments.length > 1 ? arguments[1] : undefined;
		}
		return originalGetTiddlerText.apply(wiki,arguments);
	};
	try {
		return render();
	} finally {
		wiki.getTiddler = originalGetTiddler;
		wiki.getTiddlerText = originalGetTiddlerText;
	}
}

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
			if(isBlockedTitle(body.title)) {
				sendJson(response,403,{ok:false,error:"system tiddler not exposed"});
				return;
			}
			// Render an existing tiddler's body with ITS OWN content type (block
			// parse, so headings / tables / lists render natively). The type must
			// be honored: dsh-tiddlywiki writes agent notes as `text/markdown`
			// (tiddlywiki/markdown is enabled), and hardcoding wikitext rendered
			// every markdown note as source (`## x` became a wikitext list).
			// $tw.utils.getParser() falls back to text/vnd.tiddlywiki when no
			// parser is registered for the type, so passing the raw type is safe.
			var tiddler = state.wiki.getTiddler(body.title);
			if(!tiddler) {
				sendJson(response,404,{ok:false,notFound:true,title:body.title});
				return;
			}
			variables.currentTiddler = body.title;
			var tiddlerType = typeof tiddler.fields.type === "string" && tiddler.fields.type.length > 0
				? tiddler.fields.type
				: "text/vnd.tiddlywiki";
			var html = renderWithoutBlockedTitles(state.wiki,function() {
				return state.wiki.renderText("text/html",tiddlerType,tiddler.fields.text,{
					parseAsInline: false,
					variables: variables
				});
			});
			response.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store"});
			response.end(html);
			return;
		}
		if(typeof body.text === "string") {
			// Render arbitrary wiki text (contextTitle gives currentTiddler so
			// links/transclusions resolve in that tiddler's context). `type`
			// optionally selects the parser (e.g. text/markdown); the default is
			// wikitext, and unknown types fall back to it inside TW.
			if(typeof body.contextTitle === "string" && body.contextTitle.length > 0) {
				if(isBlockedTitle(body.contextTitle)) {
					sendJson(response,403,{ok:false,error:"system tiddler not exposed"});
					return;
				}
				variables.currentTiddler = body.contextTitle;
			}
			var inline = body.parseAsInline === true;
			var bodyType = typeof body.type === "string" && body.type.length > 0 ? body.type : "text/vnd.tiddlywiki";
			var textHtml = renderWithoutBlockedTitles(state.wiki,function() {
				return state.wiki.renderText("text/html",bodyType,body.text,{
					parseAsInline: inline,
					variables: variables
				});
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
