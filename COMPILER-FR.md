# Vaiana Coding — compiler l'app (Windows)

Vaiana Coding est basée sur Roxlit 0.16.0 (licence MIT, voir LICENSE), avec un onglet **Mes jeux** et un onglet **Agents** en plus :
chat avec plusieurs agents Claude Code en parallèle, bouton « Playtest auto » et
bouton « Sauvegarder (Git) ».

## Ce qu'il faut installer une seule fois

1. **Node.js 22** : https://nodejs.org
2. **Rust** : https://rustup.rs (accepte l'installation des « Visual Studio C++ Build Tools » quand il la propose)
3. **Git** : https://git-scm.com
4. **Claude Code**, puis lance `claude` une fois dans un terminal pour te connecter.

## Compiler

Ouvre PowerShell dans ce dossier :

```
npm ci
npx tauri build
```

La première compilation prend 10 à 20 minutes. L'installeur sort dans
`src-tauri\target\release\bundle\nsis\`.

## Fichiers ajoutés ou modifiés

- `src-tauri/src/commands/agents.rs` : lancement des agents et sauvegardes Git (nouveau)
- `src/hooks/useAgents.ts`, `src/components/launcher/AgentsPanel.tsx` : interface du chat (nouveau)
- `src/components/launcher/Launcher.tsx`, `src-tauri/src/lib.rs`, `src-tauri/src/commands/mod.rs`, `src-tauri/tauri.conf.json` : branchement

## Sur un autre PC

Copie seulement l'installeur (ou `vaiana-coding.exe`) : au premier lancement, l'app installe elle-même Git, Node.js et Claude Code, puis te fait te connecter à Claude. Rust et les Build Tools ne servent qu'à compiler, pas à utiliser l'app.

## Connexion à Studio

N'utilise pas le plugin Rojo classique : l'app installe son propre plugin (Roxlit.rbxm) qui se connecte tout seul à la place ouverte quand tu cliques sur Start Development. Si tu ouvres un autre jeu que la dernière fois, Studio affiche une notification : clique sur « Link & Connect » et l'app bascule sur le dossier de ce jeu (elle le crée s'il n'existe pas).

## À savoir

- Si l'app propose une mise à jour Roxlit, ignore-la : c'est la version officielle, sans tes onglets.
- Les agents travaillent en même temps et sans s'attendre. Ils partagent le même dossier et le même Studio : un seul playtest à la fois.
- Blender : installe-le depuis https://www.blender.org pour activer le bouton « Blender ». Les agents écrivent leurs scripts dans `blender/scripts/` et exportent dans `blender/exports/`. L'import dans Studio se fait à la main : File > Import 3D.
