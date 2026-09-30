@echo off
title CheckYourMorpho Sync Engine
echo [CheckYourMorpho] Running on-chain synchronization with Morpho GraphQL API...
node server/services/syncEngine.js
pause
