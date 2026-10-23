# sparti.co.th — frontend

The built single-page frontend for **sparti.co.th**, packaged as a static bundle so a
plain web server can serve it. No build step, no Node, no server-side runtime — these
are the compiled files exactly as a browser receives them.

Target host: Z.com / ZWH shared hosting (`ps15.zwhosting.com`, `118.27.146.19`),
document root `/home/zgtnzpsz/sparti.co.th/`.

## What is in here

| Path | What it is |
| --- | --- |
| `index.html` | the application shell — every route boots from this file |
| `assets/` | the hashed JS/CSS chunks; the filename hash changes on every build |
| `brand/` | Sparti logo assets used by the shell |
| `fonts/`, `lovable-uploads/`, `placeholder.svg` | static assets the shell references |
| `sw.js` | service worker |
| `t.js`, `gate.js` | telemetry and the load gate |
| `manifest*.json` | web app manifests |
| `oauth/composio/callback.html` | OAuth callback page |
| `.htaccess` | **required** — SPA routing fallback plus cache headers |
| `.cpanel.yml` | optional deploy tasks, for when the clone lives outside the document root |

## What is deliberately NOT in here

The platform builds one shared bundle that carries **every** client's theme chunks and
a `public/` folder shared by all sites. Publishing that would hand one customer another
customer's material, so this repository is a **single-tenant** build
(`build-tenant-dist.sh --slug sparti-th`, isolation verified) with the shared leftovers
removed:

- other clients' brand assets (`allonsy/`, `nomi-reviews/`, `asset/nomi-font/`, `asset/str-fitness/`, `brand/frnch/`)
- internal material (`prototypes/`, `slides/`, `office-skins/`, `wireframes/`, `deck-proof/`)
- staff imagery (`office-people/`, `office-pets/`)
- another brand's concept page (`yatai-concept.html`)
- crawler files (`robots.txt`, `sitemap.xml`, `indexnow.txt`) — these must always
  originate on the platform, never a copy here

None of the removed paths was referenced by any built file (verified by grep against
`index.html`, `assets/`, `sw.js`, `t.js`, `gate.js` and the manifests).

## Deploying to cPanel

cPanel → **Git Version Control** → **Clone a Repository**:

- Clone URL: `https://github.com/<account>/sparti-co-th-frontend.git`
- Repository Path: `/home/zgtnzpsz/sparti.co.th/`
- Repository Name: `sparti-co-th-frontend`

Cloning into the document root puts `index.html` at the site root, so the site answers
on `sparti.co.th/` rather than a subfolder. The repository is public, so cPanel needs no
credentials to clone it.

Afterwards: **SSL/TLS Status → Run AutoSSL** to replace the self-signed certificate, and
add the DNS `A` record `sparti.co.th → 118.27.146.19` if it is not already pointed.

## Updating

The bundle is rebuilt on the build host and pushed here; cPanel then pulls it
(**Update from Remote**), or re-runs **Deploy HEAD Commit** if it was cloned elsewhere.
The asset hashes change on each build, which is how you confirm a deploy landed.

## Note on the API

This is the frontend only. It calls the content API over HTTPS; it does not contain the
API, the database, or any credentials. Moving the API is a separate piece of work.
