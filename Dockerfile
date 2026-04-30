FROM denoland/deno:alpine-1.42.0

# Set the working directory
WORKDIR /app

# Copy the manifest and lockfile if present
COPY deno.json .

# Copy the source code
COPY src/ ./src/
COPY config.example.ts .

# Pre-cache dependencies
RUN cp config.example.ts config.ts
RUN deno cache src/main.ts

# Run as an unprivileged user
USER deno

# The entry point command
CMD ["task", "start"]
