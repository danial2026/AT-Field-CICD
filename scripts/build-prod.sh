#!/bin/bash
# Example build script for production
set -e

echo "Building application for production..."
echo "Current directory: $(pwd)"
echo "Node version: $(node --version)"

# Example steps (customize for your project)
npm ci
npm run build:prod
npm run test

echo "Build successful!"
