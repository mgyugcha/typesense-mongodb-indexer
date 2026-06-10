#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

echo "=== Fase 1: Respaldo de config.ts ==="
cp config.ts config.ts.prod

cleanup() {
  echo "=== Limpieza: restaurar config.ts y bajar servicios ==="
  mv config.ts.prod config.ts 2>/dev/null || true
  docker compose -f docker-compose.test.yml down -v 2>/dev/null || true
  echo "=== Hecho ==="
}
trap cleanup EXIT

echo "=== Fase 2: Iniciar servicios de test ==="
docker compose -f docker-compose.test.yml up -d

echo "=== Fase 3: Esperar a que los servicios estén listos ==="

echo "Esperando MongoDB..."
for i in $(seq 1 20); do
  if docker compose -f docker-compose.test.yml exec -T mongodb-test mongosh --quiet --eval 'db.adminCommand("ping")' 2>/dev/null; then
    echo "MongoDB listo"
    break
  fi
  if [ "$i" -eq 20 ]; then
    echo "ERROR: MongoDB no respondió"
    exit 1
  fi
  sleep 2
done

echo "Inicializando replica set de MongoDB..."
docker compose -f docker-compose.test.yml exec -T mongodb-test mongosh --quiet --eval '
  rs.initiate({
    _id: "rs0",
    members: [{ _id: 0, host: "localhost:27017" }]
  })
' 2>&1
sleep 3

echo "Esperando Typesense..."
for i in $(seq 1 20); do
  if curl -sf http://localhost:8109/health > /dev/null 2>&1; then
    echo "Typesense listo"
    break
  fi
  if [ "$i" -eq 20 ]; then
    echo "ERROR: Typesense no respondió"
    exit 1
  fi
  sleep 2
done

echo "Esperando Redis..."
for i in $(seq 1 20); do
  if docker compose -f docker-compose.test.yml exec -T redis-test redis-cli ping 2>/dev/null | grep -q PONG; then
    echo "Redis listo"
    break
  fi
  if [ "$i" -eq 20 ]; then
    echo "ERROR: Redis no respondió"
    exit 1
  fi
  sleep 2
done

echo "=== Fase 4: Copiar config.test.ts como config.ts ==="
cp config.test.ts config.ts

echo "=== Fase 5: Ejecutar tests ==="
deno test \
  --allow-net \
  --allow-read \
  --allow-env \
  --allow-ffi \
  --allow-sys \
  --allow-write \
  tests/ \
  "$@"

echo "=== Tests completados ==="
