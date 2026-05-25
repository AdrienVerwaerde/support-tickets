# Analyse du Dockerfile

---

## Pourquoi utilise-t-on un multi-stage build plutôt qu'un seul FROM ?

On utilise un multi-stage pour diviser les informations contenues dans l'image finale. Si on utilisait un seul FROM, l'image finale contiendrait tout ce qui a servi à la construire (code source, cache npm, compilateur TS, les 'devDependencies' ...). Utiliser le multi-stage permet donc plusieurs choses : 

- **Réduire la taille de l'image** en n'intégrant que les artefacts nécessaires à l'exécution
- **Ajouter de la sécurité** en réduisant les outils contenus dans l'image et ainsi empêcher un attaquant d'accéder à l'ensemble des informations de l'application
- **Séparation des responsabilités** en plusieurs étapes ayant un rôle précis : `deps` installe, `builder` compile, `runner` exécute. La logique est donc plus lisible et plus facile à maintenir
- **Cache de build efficace** : tant que les fichiers `package.json` et `package-lock.json`ne changent pas, Docker réutilise le cache existant et ne réexécute pas le `npm ci` ce qui permet de réaliser des builds plus rapidement
- **Reproductibilité** graĉe au fait que l'environnement de build et celui d'exécution sont isolés l'un de l'autre. Cela évite des erreurs de variables ou de fichiers temporaires qui pourraient survenir si les deux environnements tournaient sur la même image

---

## Que fait la ligne output: 'standalone' dans next.config.js et comment Docker l'exploite-t-elle ?

Pour exécuter une application Next.js en production il faut avoir "Next" installé et lancer `next start`, ce qui inclut de copier la totalité du dossier `node_modules` dans l'image ce qui peut représenter énormément de poids (plusieurs centaines de MO parfois)

Avec `output: 'standalone'`, Next.js fait deux choses au moment du `next build` :

1. Il trace les fichiers réellement importés (via `@vercel/nft`) par le serveur et n'inclut que ceux-là, en soi cela crée un sous-ensemble minimal de `node_modules` pour éviter de tout copier.
2. Il génère un dossier `.next/standalone/` autonome contenant un **`server.js`** prêt à l'emploi, ainsi que les `node_modules` strictement nécessaires.

Le `Dockerfile` exploite directement cette sortie :

```dockerfile
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
...
CMD ["node", "server.js"]
```

- L'étape `runner` ne fait aucun `npm install`, elle ne contient pas `npm` au runtime, juste Node.
- On lance le serveur avec `node server.js` au lieu de `next start`, donc plus besoin du binaire `next` ni de `node_modules` complet.
- Les assets statiques (`.next/static`) et les fichiers publics (`public/`) sont copiés à part car le tracer ne les inclut pas — c'est le serveur qui les sert depuis le disque.

Résultat : une image de runtime nettement plus petite (quelques centaines de MO de moins) et un démarrage plus rapide.

---

## Pourquoi crée-t-on un utilisateur nextjs non-root ?

Par défaut, les processus dans un conteneur Docker tournent en `root` (UID 0). Cela paraît anodin parce qu'on est « isolé » dans un conteneur, mais c'est une mauvaise pratique pour plusieurs raisons :

- **Principe du moindre privilège.** L'application Next.js n'a aucun besoin légitime d'être root : elle ouvre un port > 1024 (3000), lit des fichiers statiques, écrit dans `/app/data`. Elle n'a pas besoin d'accéder à l'ensemble des droits comme un user root lui fournirait.
- **Limitation de l'impact d'une compromission.** Si une faille applicative (RCE, injection, dépendance vulnérable) permet à un attaquant d'exécuter du code, il hérite des droits du processus. En non-root, il ne peut pas installer de paquets, modifier les binaires système, écrire en dehors des dossiers explicitement ouverts en écriture.
- **Défense en profondeur contre les évasions de conteneur.** Historiquement, plusieurs CVE (`runc`, capabilities mal configurées…) ont permis à un processus root dans un conteneur de gagner du root sur l'hôte. Un utilisateur non-root rend ces escalades nettement plus difficiles.
- **Compatibilité avec les orchestrateurs durcis.** Kubernetes avec `PodSecurityStandards` en mode *restricted*, OpenShift, ou des politiques `runAsNonRoot: true` refuse de démarrer un conteneur qui tourne en root. Préparer l'image dès maintenant évite donc d'avoir à la refaire plus tard.

C'est pour cela que le `Dockerfile` crée explicitement le groupe et l'utilisateur, donne à `nextjs` la propriété des artefacts copiés (`--chown=nextjs:nodejs`) et du dossier de données (`chown -R nextjs:nodejs /app/data`), puis bascule avec `USER nextjs` avant l'instruction `CMD`.

---

## À quoi sert `HEALTHCHECK` dans le Dockerfile ?

```dockerfile
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/health || exit 1
```

`HEALTHCHECK` indique à Docker comment vérifier que l'application à l'intérieur du conteneur fonctionne réellement, et non pas seulement que le processus est encore en vie. Un processus Node peut très bien rester démarré tout en étant bloqué (deadlock, base de données injoignable, event loop saturée) : la commande `docker ps` le verra « Up », mais l'application sera de fait hors service.

- Toutes les 30 secondes (`--interval`), Docker exécute la commande à l'intérieur du conteneur.
- La commande envoie une requête HTTP à l'endpoint applicatif `/api/health` avec `wget --spider` (qui ne télécharge rien, vérifie juste que la réponse est 2xx).
- Si la commande met plus de 3 secondes (`--timeout`), elle est considérée comme un échec.
- Pendant les 10 premières secondes (`--start-period`), les échecs ne comptent pas — c'est le temps laissé à l'application pour démarrer.
- Après 3 échecs consécutifs (`--retries`), le conteneur passe à l'état `unhealthy`.

En résumé :`HEALTHCHECK` transforme le conteneur en composant observable et auto-réparable, ce qui est indispensable en production.

---

## Quelle est votre couverture finale (% statements / branches / functions) ?

Fichier	Statements	Branches	Functions	Lines
auth.ts	100%	100%	100%	100%
permissions.ts	100%	100%	100%	100%
validators.ts	100%	100%	100%	100%
prisma.ts	0%	0%	0%	0%
src/lib total	87.3%	92.3%	85.7%	87.3%

---

## Pourquoi la couverture est < 100% ?

Car `prisma.ts` reste à 0%
Ce fichier initialise le client Prisma (connexion à la base de données). Il n'est pas couvert car :

***Dépendance infrastructure :*** il nécessite une vraie base SQLite à l'exécution, on ne l'importe pas dans les tests unitaires pour éviter des effets de bord
***Pattern singleton :*** il exporte une instance globale Prisma, testable uniquement en tests d'intégration (avec une DB de test dédiée)
***Pratique standard :*** les tests unitaires mockent Prisma plutôt que de l'exécuter réellement
***Global All files :*** 5.4% statements
Le rapport inclut tous les fichiers du projet (routes API Next.js, pages React, scripts k6, seed Prisma). Ces fichiers ne sont pas testables en unit testing :

Les routes API `(src/app/api/**)` dépendent du runtime Next.js et de la DB
Les pages React `(src/app/**/*.tsx)` nécessitent un environnement DOM (tests d'intégration avec Playwright/Cypress)
Les scripts k6 s'exécutent dans leur propre runtime JS
Les 87–100% sur `src/lib/` sont le chiffre pertinent pour les tests unitaires.

---

## Pentester l'app

**Peut-on changer le role ?**
Oui, il y a une vulnérabilité. La signature HMAC-SHA256 d'un JWT ne prouve rien d'autre que "celui qui a produit ce token connaissait le secret". Ici le secret est :

- court (moins de 32 octets aléatoires),
- prédictible (changeme, secret, dev…),
- ou exposé dans un .env.example versionné sur Git,

N'importe qui peut générer un token valide arbitraire car un JWT n'est pas sécurisé en soi ; il l'est uniquement si le secret de signature l'est. C'est ce qu'on appelle parfois la "confused deputy" en application au cas JWT : le serveur délègue sa confiance à un secret qu'il pensait privé.

**Trois mitigations :**
1. Secret fort, long, et hors du dépôt.
Un secret HMAC-SHA256 doit faire au minimum 256 bits d'entropie, soit 32 octets aléatoires (openssl rand -base64 32). Il ne doit jamais apparaître dans le code, ni dans un .env.example, ni dans l'historique Git. Il est injecté à l'exécution via un gestionnaire de secrets (Docker secrets, AWS Secrets Manager, HashiCorp Vault, Kubernetes Secrets chiffrés, etc.). Le .env.example ne contient qu'un placeholder explicite (JWT_SECRET=replace-with-32-random-bytes) accompagné d'une commande pour le générer.

2. Rotation périodique avec gestion de plusieurs clés actives.
Même un bon secret se compromet : fuite dans des logs, ex-employé, vulnérabilité d'une dépendance, etc. Le serveur doit donc savoir vérifier un token avec une ou plusieurs clés en parallèle (key rotation) :

- ajouter kid (key ID) dans l'en-tête JWT
- maintenir un trousseau côté serveur (clé active pour signer, anciennes clés acceptées pour vérifier pendant la fenêtre de transition)
- forcer une expiration exp courte (15 min) avec un refresh token séparé, ce qui réduit la durée d'exploitation d'un token forgé ou volé.

3. Algorithme robuste et claims minimaux/vérifiés côté serveur.
Plusieurs durcissements complémentaires sur la cryptographie et la confiance dans les claims :

- forcer l'algorithme attendu côté vérification (algorithms: ['HS256'] ou mieux ['RS256']) pour bloquer l'attaque historique alg: none et l'attaque de confusion HMAC/RSA
- passer à une signature asymétrique (RS256/EdDSA) : le serveur d'auth signe avec une clé privée jamais exposée, les services qui vérifient ne détiennent que la clé publique
- ne jamais faire confiance aux claims sensibles dans le token. Le role ne devrait pas être lu depuis le JWT mais re-fetché depuis la DB à partir du userId. Le JWT prouve l'identité, les permissions sont une donnée d'autorité qui appartient au serveur. Cela neutralise complètement l'attaque même si le secret fuit (au pire l'attaquant usurpe l'identité d'un USER existant, pas de l'admin).

---

## Headers de sécurité manquants 

- Strict-Transport-Security (HSTS)
- Content-Security-Policy (CSP)
- X-Frame-Options (ou CSP frame-ancestors)
- X-Content-Type-Options: nosniff
- Referrer-Policy
- Permissions-Policy

```js
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(_req: NextRequest) {
  const res = NextResponse.next();

  res.headers.set(
    'Strict-Transport-Security',
    'max-age=63072000; includeSubDomains; preload'
  );
  res.headers.set('X-Content-Type-Options', 'nosniff');
  res.headers.set('X-Frame-Options', 'DENY');
  res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.headers.set(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), interest-cohort=()'
  );
  res.headers.set(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; ')
  );

  return res;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};```

---

```

---

# Synthèse finale

## Architecture finale

```
dev (local)
    │
    ├─ git push
    │
    ▼
GitHub (AdrienVerwaerde/support-tickets)
    │
    ├─ GitHub Actions CI/CD
    │   ├─ test    : lint + unit tests + coverage
    │   ├─ security: npm audit + Trivy FS scan
    │   ├─ docker  : build + Trivy image scan
    │   └─ deploy  : build + push → ACR (main only)
    │
    ▼
Azure Container Registry (helpdeskacrav.azurecr.io)
    │
    ├─ ACR Webhook (push :latest)
    │
    ▼
Azure App Service (helpdesk-av.azurewebsites.net)
    └─ Container Linux B1
       ├─ entrypoint : prisma migrate + seed + node server.js
       └─ SQLite persisté sur /home (App Service Storage)
```

## 3 améliorations DevSecOps

1. **Azure Key Vault** pour les secrets (`JWT_SECRET`, credentials DB) : évite de les stocker dans les App Settings (visibles dans le portail). L'App Service accède au Key Vault via une Managed Identity, sans jamais exposer les valeurs.
2. **Application Insights** (monitoring) : traçabilité des erreurs, alertes sur le taux d'erreur ou la latence p95, dashboards en temps réel. Indispensable pour détecter les incidents en production avant les utilisateurs.
3. **Base de données managée** (Azure Database for PostgreSQL Flexible Server) à la place de SQLite : réplication, sauvegardes automatiques, scaling horizontal possible. SQLite est acceptable pour un TP mono-instance mais non viable en production.

## Coût Azure estimé

| Service | SKU | Coût mensuel estimé |
|---|---|---|
| App Service Plan B1 | Basic Linux | ~13 $/mois |
| Azure Container Registry | Basic | ~5 $/mois |
| **Total** | | **~18 $/mois** |

Sur le crédit de 100 $ Azure for Students, cela représente environ 18 % consommé par mois.

## Ce qui a posé problème

- **SSH dans le conteneur impossible** : Azure App Service ne permet pas `az webapp ssh` sur des images custom Alpine sans SSH server installé. Solution : entrypoint.sh qui auto-migre et auto-seed au premier démarrage, en utilisant le volume persistant `/home` pour un flag `.seeded`.
- **Service principal interdit** : Azure for Students bloque `az ad sp create-for-rbac` (permissions AD insuffisantes). Solution : ACR Webhook + Continuous Deployment natif Azure, sans avoir besoin de `AZURE_CREDENTIALS`.
- **Trivy scan de l'image en CI** : le job `docker` buildait l'image avec `push: false` mais ne la chargeait pas dans le daemon Docker local, rendant le scan Trivy impossible. Corrigé avec `load: true` dans l'action `docker/build-push-action`.
