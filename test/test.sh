#!/usr/bin/env bash

set -e

npm i @diplodoc/infra
npx @diplodoc/infra init
npm run lint:fix