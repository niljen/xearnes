# Xearnes : checklist des comptes payants (avant de configurer Stripe)

Mise à jour : 2026-10-15. Cases cochées = déjà fait. Rien ici n'est un avis juridique : les points marqués ⚖️ sont à confirmer avec un avocat, Skatteverket (impôts) ou IMY.

Qui décide : **Youssef** (chef de projet) choisit les offres et les prix. **Papa** conseille sur le légal, la sécurité et l'argent, et fait les actions dans les comptes (Stripe, banque). **Claude** écrit et teste le code.

---

## 0. Les 4 blocages à régler en premier

1. **Qui paie et qui encaisse.** Le titulaire du compte Stripe doit être un adulte (Stripe accepte l'ouverture dès 13 ans, mais en dessous de 18 ans il faut un représentant adulte, parent ou tuteur, qui est responsable). → Papa.
2. **Preuve que l'email est bien celui du payeur.** Aujourd'hui, n'importe qui peut taper l'email d'un abonné et obtenir son niveau payant (aucune vérification). Il faut un code envoyé par email, ou un lien magique, avant d'activer un niveau.
3. **Le webhook Stripe n'enregistre probablement rien.** Dans le code actuel, l'email est cherché dans l'objet « abonnement », qui ne le contient normalement pas (il contient un identifiant client). Il faut écouter `checkout.session.completed` ou relire le client via l'API Stripe.
4. **Ce que chaque niveau donne vraiment.** Pro, Ultra et Legend sont décrits sur le site, mais côté serveur rien ne distingue encore un abonné d'un autre : les thèmes et les limites sont gérés dans le navigateur (modifiables par l'utilisateur).

---

## 1. Compte, statut légal et argent (Papa)

- [ ] Choisir qui est le vendeur : personne privée, entreprise individuelle (enskild firma) ou société. ⚖️
- [ ] Voir avec Skatteverket : déclaration du revenu, immatriculation (F-skatt) et TVA. ⚖️
- [ ] Ouvrir le compte Stripe au nom d'un adulte, avec pièce d'identité, adresse et compte bancaire.
- [ ] Activer l'authentification à deux facteurs sur Stripe.
- [ ] Vérifier les frais de Stripe et le délai de versement sur le compte bancaire.
- [ ] Décider de la monnaie (SEK ? EUR ?) et si les prix incluent la TVA suédoise (25 % sur les services numériques, à confirmer ; règles différentes pour les clients d'autres pays de l'UE). ⚖️
- [ ] Prévoir la comptabilité : garder les factures (en Suède, environ 7 ans). ⚖️
- [ ] Garder un solde de sécurité et des alertes (litiges, paiements refusés) sur le tableau de bord Stripe.

## 2. Offres et prix (Youssef décide)

- [ ] Définir **exactement** ce que contient chaque niveau (Pro / Ultra / Legend) : modèle plus puissant ? plus de conversations sauvegardées ? thèmes ? mémoire ? accès au gros modèle sur RunPod ?
- [ ] Vérifier la cohérence : prix dans l'appli (200 / 500 / 1000 kr par mois), page `pricing.html` (autres chiffres : 20, 100, 250, 600 kr…) et Stripe. Un seul tableau de prix, partout identique.
- [ ] Vérifier que le prix couvre le coût réel (RunPod : environ 0,12 $ par démarrage du GPU, plafond de 6 par jour).
- [ ] Décider : mensuel seulement, ou aussi annuel ? période d'essai ? réduction ?
- [ ] Décider ce qui arrive à l'annulation : accès jusqu'à la fin de la période payée, puis retour au niveau gratuit.

## 3. Dans Stripe (compte en mode test d'abord)

- [ ] Créer 3 produits avec leurs prix récurrents. Noter les 3 identifiants de prix (`price_…`) : ils vont dans `STRIPE_PRICE_PRO`, `STRIPE_PRICE_ULTRA`, `STRIPE_PRICE_LEGEND`.
- [ ] Activer le calcul de TVA / Stripe Tax si on vend avec TVA. ⚖️
- [ ] Créer les liens de paiement (Payment Links) ou une page Checkout, qui **demande l'email** et le transmet.
- [ ] Activer le **portail client** Stripe (changer de carte, annuler, télécharger les factures) : le client s'autogère, ça évite d'écrire cette partie.
- [ ] Mettre le nom du vendeur, l'adresse de contact et les liens vers les conditions et la confidentialité dans les réglages de Stripe (reçus, page de paiement).
- [ ] Créer une clé API **restreinte** (permissions minimales) plutôt que la clé secrète complète. Ne jamais la mettre dans le dépôt ni dans le chat : seulement en secret Cloudflare.
- [ ] Créer le point de terminaison de webhook vers `…/stripe-webhook` et noter son secret (`whsec_…`).
- [ ] Événements à écouter : `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`.

## 4. Pages à publier sur le site

- [x] Page de confidentialité (`privacy.html`) : existe, mais **sans section paiement**.
- [ ] Section paiement dans la confidentialité : Stripe traite nom, email, moyen de paiement, adresse de facturation ; nous gardons l'email et le niveau ; durée de conservation (comptabilité) ; paiement réservé aux adultes et aux parents.
- [ ] **Conditions d'utilisation et de vente** : contenu de l'abonnement, prix TTC, renouvellement automatique, comment annuler, âge (18 ans ou accord d'un parent), disponibilité du service, limites de responsabilité. ⚖️
- [ ] **Rétractation et remboursement** : droit de rétractation de 14 jours pour un service en ligne et ce qui se passe quand le service commence tout de suite ; procédure de remboursement. ⚖️
- [ ] **Identité du vendeur et contact** : nom ou nom d'entreprise, adresse, email de support. La mention « l'équipe Xearnes » ne suffira probablement plus pour vendre. ⚖️
- [ ] Information sur les réclamations (autorité suédoise des consommateurs, ARN). ⚖️
- [ ] Case ou phrase claire avant le paiement : prix, durée, renouvellement automatique, lien vers les conditions.

## 5. Technique (Claude, avec Papa pour les secrets)

**État actuel :** le Worker « xearnes-claude » (fichier `worker.js` à la racine) contient `/check-sub` (email vers niveau, stocké dans KV `SUBSCRIPTIONS`) et `/stripe-webhook` (signature vérifiée). Ce fichier a des modifications non committées d'avant mon travail, et je ne sais pas ce qui est déployé.

- [ ] Savoir exactement quelle version de ce Worker est déployée, et reprendre le fichier proprement dans git.
- [ ] Corriger le webhook : retrouver l'email depuis `checkout.session.completed` (ou le client), gérer les états `active`, `trialing`, `past_due`, `canceled`, et rendre le traitement idempotent (même événement reçu deux fois).
- [ ] Vérification de l'email : code à 6 chiffres envoyé par email (il faut un service d'envoi) ou lien magique, avant d'activer le niveau sur un appareil.
- [ ] `/check-sub` : ne plus mettre l'email dans l'adresse web ; utiliser POST ; limiter les essais ; ne pas révéler si un email existe.
- [ ] **Appliquer le niveau côté serveur** : le Worker décide (modèle, RunPod, limites), pas le navigateur. Aujourd'hui le niveau est lu dans le navigateur (`xn_sub_cache`), donc modifiable.
- [ ] Brancher les niveaux sur le routage RunPod (par exemple : accès prioritaire au gros modèle pour les abonnés).
- [ ] Secrets Cloudflare : `STRIPE_WEBHOOK_SECRET`, `STRIPE_SECRET_KEY` (clé restreinte), `STRIPE_PRICE_*`. Rien dans le dépôt.
- [ ] Rendre le CORS de ce Worker strict (il autorise `*` aujourd'hui) et une vraie limite de requêtes par IP (celle en mémoire ne tient pas entre les instances).
- [ ] Remplacer les liens provisoires `STRIPE_PRO_LINK`, `STRIPE_ULTRA_LINK`, `STRIPE_LEGEND_LINK` dans la fenêtre d'abonnement.
- [ ] Retirer ou mettre à jour le vieux chemin « niveau gratuit vers Phi-4 sur RunPod » (ancien endpoint) dans ce Worker, s'il est encore actif.
- [ ] Après le paiement : page de confirmation qui explique comment activer son accès.
- [ ] Gérer la suppression des données d'un abonné (email dans KV) sur demande.
- [ ] Surveiller : journaux d'erreurs du webhook, alertes Stripe, compteurs RunPod.

## 6. Tests (toujours en mode test de Stripe)

- [ ] Carte de test `4242 4242 4242 4242` : paiement réussi, niveau activé.
- [ ] Carte refusée (`4000 0000 0000 0002`) : rien n'est activé, message clair.
- [ ] Renouvellement (horloge de test Stripe) : le niveau reste actif.
- [ ] Paiement qui échoue au renouvellement : période de grâce, puis retour au gratuit.
- [ ] Annulation depuis le portail client : accès jusqu'à la fin de la période, puis gratuit.
- [ ] Remboursement : le niveau est retiré.
- [ ] Même événement reçu deux fois : un seul effet.
- [ ] Email déjà utilisé sur un autre appareil : la vérification marche.
- [ ] Modifier le niveau dans le navigateur ne donne aucun avantage côté serveur.
- [ ] Faux webhook (mauvaise signature) : refusé.
- [ ] Passage en mode réel : un vrai paiement de 1 SEK, vérifié puis remboursé.

## 7. Enfants et paiements

- [ ] Texte clair : l'abonnement est réservé aux adultes et aux parents. En Suède, un mineur ne peut en général pas conclure ce contrat seul. ⚖️
- [ ] Aucune donnée de carte ne passe par Xearnes : tout se fait sur les pages hébergées par Stripe.
- [ ] Les enfants gardent le chat gratuit sans email ni compte.
- [ ] Un parent peut voir et supprimer l'email et l'abonnement lié.

## 8. Après le lancement

- [ ] Vérifier chaque semaine : paiements, litiges, remboursements, coût RunPod par rapport aux revenus.
- [ ] Revoir les prix après un mois de vraies données.
- [ ] Garder une copie des contrats signés (Stripe, RunPod) et des conditions publiées.

---

## 9. Promesses de `pricing.html` contre ce que l'appli fait vraiment (audit du 2026-10-15)

| Promesse | Où | Réalité aujourd'hui | État |
|---|---|---|---|
| IA plus puissante : Pro « intelligente », Ultra « très puissante », Legend « la plus puissante » | pricing + fenêtre d'abonnement | L'appli envoie `mistral-large/medium/small-latest` selon le niveau, mais le Worker **ignore ce champ** et répond toujours avec `gemma3:4b` sur Oracle (ou le 8B RunPod pour les questions difficiles). Un abonné reçoit donc la même IA qu'un utilisateur gratuit. | ❌ non livré |
| Réponses plus longues (Ultra, Legend) | code (`max_tokens` 6000 contre 2500) | Le Worker plafonne à 600 jetons pour tout le monde. | ❌ non livré |
| Mode code | pricing | Le mode code existe, avec limites de longueur par niveau ; le modèle est le même pour tous. | ⚠️ partiel |
| Mémoire longue | pricing | Active pour Pro et plus, mais depuis le 12 oct. elle ne retient que les centres d'intérêt (plus le prénom, l'âge ni la ville). | ⚠️ réduit |
| Images par jour : 5 / 20 / illimitées | pricing | **Retiré de la page des prix** (décision de Youssef, 2026-10-16) : la génération d'images est abandonnée pour l'instant. Aucune image n'a jamais été générée ; une demande « dessine… » renvoie seulement une description écrite par le modèle. | ✅ retiré |
| Conversations enregistrées : 5 / 20 / 50 / illimitées | pricing | Fonctionne (dans le navigateur, donc modifiable par l'utilisateur). | ✅ (côté navigateur) |
| Thèmes exclusifs : 3 / 6 / tous | pricing | Le sélecteur de couleur a été retiré de l'en-tête le 12 oct. : **plus aucun moyen de choisir un thème**. | ❌ non livré |
| Graphiques avancés (Ultra, Legend) | pricing | Fonctionne (côté navigateur). | ✅ |
| Défis secrets (Ultra, Legend) | pricing | Présents, liés au niveau (côté navigateur). | ✅ |
| Badges Pro / Ultra / Legend | pricing | Ils sont donnés sans message dans le chat, visibles dans le panneau des niveaux. | ✅ |
| « Entre ton email et ton plan s'active automatiquement » | pricing | Il n'y a plus de popup email ; l'email se saisit depuis la fenêtre d'abonnement. L'activation dépend du webhook (douteux) et n'est pas vérifiée. | ⚠️ à refaire |
| Offres : « 1er abonné −90 % à vie », « 10 premiers −50 % », « 1 place restante », « 10 places restantes », remise de montée de niveau, Black Friday, Noël, rentrée… | pricing | Ce sont des textes fixes : aucun code ni coupon Stripe ne les applique, et les compteurs de places ne sont pas réels. Des promesses de rareté qui ne sont pas vraies peuvent être illégales. ⚖️ | ❌ à retirer ou à construire |
| Texte en pied de page : « Créé par Youssef, 11 ans, Malmö » | pricing | Décision déjà prise de le garder, notée ici pour mémoire. | — |

**Conséquence :** avant de passer Stripe en mode réel, soit on livre ces promesses, soit on réduit la page à ce qui existe.
