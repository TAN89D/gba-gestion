# Installation GBA Gestion Web — version bêta

Extraire le ZIP. Sur ordinateur, déposer dans GitHub le contenu du dossier gba-gestion-web (package.json doit être à la racine du dépôt). Ne pas déposer le ZIP lui-même : GitHub ne le décompresse pas.

Cloudflare Workers : connecter le dépôt GitHub, branche main. Compilation : npm run build. Déploiement : npx wrangler deploy. Utiliser Node.js 22 et la configuration wrangler.jsonc incluse. Ce projet comporte un Worker ; le simple réglage Pages/dist ne configure pas son API.

Données : sauvegarde locale dans le navigateur, export/import JSON. La sauvegarde cloud manuelle nécessite D1, binding DB, migration migrations/0001_workspace.sql et secret BACKUP_TOKEN de 32 caractères minimum. Ne jamais déposer de secret sur GitHub.

Vérification déjà effectuée : 15 tests métier réussis et compilation réussie. Le parcours client, devis, facture, encaissement, chantier, dépenses et transfert de caisse est implémenté. OCR, synchronisation multiutilisateur et signature numérique restent à finaliser. Aucun déploiement Cloudflare confirmé. Tester avec des données fictives avant utilisation réelle.
