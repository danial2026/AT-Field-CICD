#!/bin/bash
# Example build script for development
set -e

echo "Building application for development..."
echo "Current directory: $(pwd)"
echo "Node version: $(node --version)"
echo "npm version: $(npm --version)"

# Example steps (customize for your project)
npm install
npm run build:dev

echo "Build successful!"
