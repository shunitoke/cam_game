import * as THREE from "three";
function clamp01(v) {
    return Math.min(1, Math.max(0, v));
}
export class SeaScene {
    scene = new THREE.Scene();
    mesh;
    mat;
    t = 0;
    burst = 0;
    baseW = 4.2;
    baseH = 2.4;
    constructor() {
        this.scene.background = new THREE.Color(0x05060a);
        const geom = new THREE.PlaneGeometry(this.baseW, this.baseH, 1, 1);
        this.mat = new THREE.ShaderMaterial({
            depthWrite: false,
            depthTest: false,
            transparent: false,
            uniforms: {
                uTime: { value: 0 },
                uRes: { value: new THREE.Vector2(Math.max(1, window.innerWidth), Math.max(1, window.innerHeight)) },
                u_speed: { value: 1.0 },
                u_waveHeight: { value: 1.0 },
                u_waveFrequency: { value: 1.0 },
                u_perspective: { value: 1.0 },
                u_atmosphere: { value: 1.0 }
            },
            vertexShader: `
        varying vec2 vUv;
        void main(){
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
            fragmentShader: `
        precision mediump float;
        varying vec2 vUv;

        uniform float uTime;
        uniform vec2 uRes;

        uniform float u_speed;
        uniform float u_waveHeight;
        uniform float u_waveFrequency;
        uniform float u_perspective;
        uniform float u_atmosphere;

        const int NUM_STEPS = 24;
        const float EPSILON = 1e-3;

        float hash(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
        }

        float noise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          f = f * f * (3.0 - 2.0 * f);

          float a = hash(i);
          float b = hash(i + vec2(1.0, 0.0));
          float c = hash(i + vec2(0.0, 1.0));
          float d = hash(i + vec2(1.0, 1.0));

          return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
        }

        float fbm(vec2 p) {
          float value = 0.0;
          float amplitude = 0.5;
          float frequency = 1.0;

          for(int i = 0; i < 6; i++) {
            value += amplitude * noise(p * frequency);
            amplitude *= 0.5;
            frequency *= 2.0;
          }

          return value;
        }

        float seaHeight(vec2 p, float time) {
          float height = 0.0;
          float amplitude = u_waveHeight * 0.6;
          float frequency = u_waveFrequency * 0.8;

          height += sin(p.x * frequency + time * u_speed * 2.0) * amplitude;
          height += sin(p.y * frequency * 0.7 + time * u_speed * 1.5) * amplitude * 0.8;

          height += sin(p.x * frequency * 2.3 + time * u_speed * 3.2) * amplitude * 0.4;
          height += sin(p.y * frequency * 1.8 - time * u_speed * 2.8) * amplitude * 0.3;

          height += fbm(p * frequency * 2.0 + time * u_speed) * amplitude * 0.3;

          height += sin(p.x * frequency * 0.3 + time * u_speed * 0.8) * amplitude * 1.2;
          height += sin(p.y * frequency * 0.4 + time * u_speed * 0.6) * amplitude * 1.0;

          return height;
        }

        vec3 seaNormal(vec2 p, float time, float epsilon) {
          float h = seaHeight(p, time);
          float hx = seaHeight(p + vec2(epsilon, 0.0), time);
          float hy = seaHeight(p + vec2(0.0, epsilon), time);

          return normalize(vec3(h - hx, h - hy, epsilon));
        }

        vec3 skyColor(vec3 direction) {
          float horizon = max(0.0, direction.y);

          vec3 horizonColor = vec3(0.8, 0.9, 1.0);
          vec3 zenithColor = vec3(0.1, 0.3, 0.8);

          vec3 sky = mix(horizonColor, zenithColor, pow(horizon, 0.5));

          float clouds = fbm(direction.xz * 3.0) * 0.5;
          clouds = smoothstep(0.4, 0.8, clouds);
          sky = mix(sky, vec3(1.0, 1.0, 1.0), clouds * 0.3);

          vec3 sunDir = normalize(vec3(0.3, 0.8, 0.5));
          float sun = pow(max(0.0, dot(direction, sunDir)), 32.0);
          sky += vec3(1.0, 0.8, 0.4) * sun * 0.5;

          return sky;
        }

        vec3 seaColor(vec3 position, vec3 normal, vec3 lightDir, vec3 viewDir, vec3 sk) {
          vec3 deepSea = vec3(0.0, 0.2, 0.4);
          vec3 shallowSea = vec3(0.2, 0.6, 0.8);
          vec3 tropicalSea = vec3(0.3, 0.8, 0.9);

          float fresnel = pow(1.0 - max(0.0, dot(normal, viewDir)), 2.5);
          float diffuse = max(0.0, dot(normal, lightDir));

          vec3 reflected = reflect(-lightDir, normal);
          float specular = pow(max(0.0, dot(reflected, viewDir)), 128.0);

          float depth = clamp(position.y / (u_waveHeight + 0.5), 0.0, 1.0);
          vec3 seaBase = mix(deepSea, shallowSea, depth);
          seaBase = mix(seaBase, tropicalSea, diffuse * 0.3);

          float subsurface = pow(max(0.0, dot(-lightDir, normal)), 2.0);
          seaBase += vec3(0.2, 0.4, 0.6) * subsurface * 0.4;

          seaBase += vec3(1.0, 0.95, 0.8) * specular * 1.2;

          float foam = smoothstep(0.2, 0.8, position.y / (u_waveHeight + 0.1));
          seaBase = mix(seaBase, vec3(0.95, 0.98, 1.0), foam * 0.5);

          vec3 finalColor = mix(seaBase, sk * vec3(0.8, 0.9, 1.0), fresnel * 0.6);
          return finalColor;
        }

        float rayMarchSea(vec3 origin, vec3 direction, float time) {
          float t = 0.0;

          for(int i = 0; i < NUM_STEPS; i++) {
            vec3 pos = origin + direction * t;
            float height = seaHeight(pos.xz, time);

            if(pos.y < height) {
              float t1 = t - 1.0;
              float t2 = t;

              for(int j = 0; j < 8; j++) {
                float tmid = (t1 + t2) * 0.5;
                vec3 pmid = origin + direction * tmid;

                if(pmid.y < seaHeight(pmid.xz, time)) {
                  t2 = tmid;
                } else {
                  t1 = tmid;
                }
              }

              return t2;
            }

            t += 1.0;
            if(t > 100.0) break;
          }

          return -1.0;
        }

        void main(){
          vec2 fragCoord = vUv * uRes;

          vec2 uv = fragCoord / uRes.xy;
          uv = uv * 2.0 - 1.0;
          uv.x *= uRes.x / uRes.y;

          float time = uTime;

          vec3 cameraPos = vec3(0.0, 2.0 + u_perspective, time * 3.0);
          vec3 cameraTarget = vec3(0.0, 0.0, time * 3.0 + 10.0);
          vec3 cameraUp = vec3(0.0, 1.0, 0.0);

          float angle = time * 0.1;
          cameraPos.x += sin(angle) * 2.0;
          cameraPos.z += cos(angle) * 2.0;

          vec3 forward = normalize(cameraTarget - cameraPos);
          vec3 right = normalize(cross(forward, cameraUp));
          vec3 up = cross(right, forward);

          vec3 rayDir = normalize(uv.x * right + uv.y * up + forward * 2.0);

          vec3 lightDir = normalize(vec3(0.3, 0.8, 0.5));

          float t = rayMarchSea(cameraPos, rayDir, time);

          vec3 color;

          if(t > 0.0) {
            vec3 hitPos = cameraPos + rayDir * t;
            vec3 normal = seaNormal(hitPos.xz, time, 0.1);
            vec3 sk = skyColor(reflect(rayDir, normal));

            color = seaColor(hitPos, normal, lightDir, -rayDir, sk);

            float distance = length(hitPos - cameraPos);
            float fog = 1.0 - exp(-distance * 0.01 * u_atmosphere);
            color = mix(color, skyColor(rayDir), fog);
          } else {
            color = skyColor(rayDir);
          }

          color = pow(color, vec3(0.7));
          color *= 1.2;

          gl_FragColor = vec4(color, 1.0);
        }
      `
        });
        this.mesh = new THREE.Mesh(geom, this.mat);
        this.mesh.position.z = -0.4;
        this.scene.add(this.mesh);
    }
    onResize(camera) {
        const cam = camera;
        const dist = Math.abs((cam.position?.z ?? 2.2) - (this.mesh?.position?.z ?? -0.4));
        const vFov = ((cam.fov ?? 55) * Math.PI) / 180;
        const height = 2 * dist * Math.tan(vFov * 0.5);
        const width = height * (cam.aspect ?? window.innerWidth / window.innerHeight);
        this.mesh.scale.set(width / this.baseW, height / this.baseH, 1);
        const iw = Math.max(1, Math.floor(window.innerWidth));
        const ih = Math.max(1, Math.floor(window.innerHeight));
        this.mat.uniforms.uRes.value.set(iw, ih);
    }
    getScene() {
        return this.scene;
    }
    reset() {
        this.t = 0;
        this.burst = 0;
    }
    triggerBurst(amount) {
        this.burst = Math.max(this.burst, clamp01(amount));
    }
    update(control) {
        this.t += control.dt;
        this.burst = Math.max(0, this.burst - control.dt * 2.6);
        const bp = clamp01(control.beatPulse ?? 0);
        const b = clamp01(this.burst + bp * 0.85);
        const speed = clamp01(control.rightY * 0.85 + b * 0.35);
        const waveHeight = clamp01(control.rightPinch * 0.95 + b * 0.25);
        const waveFreq = clamp01(control.rightX * 0.85 + b * 0.25);
        const persp = clamp01(control.leftY * 0.85 + 0.35 * b);
        const atmo = clamp01(control.build * 0.85 + 0.45 * b);
        this.mat.uniforms.uTime.value = this.t * (0.35 + 1.65 * speed);
        this.mat.uniforms.u_speed.value = 0.65 + 1.55 * speed;
        this.mat.uniforms.u_waveHeight.value = 0.35 + 1.85 * waveHeight;
        this.mat.uniforms.u_waveFrequency.value = 0.65 + 2.25 * waveFreq;
        this.mat.uniforms.u_perspective.value = 0.35 + 2.25 * persp;
        this.mat.uniforms.u_atmosphere.value = 0.55 + 1.95 * atmo;
    }
    dispose() {
        this.mesh.geometry.dispose();
        this.mat.dispose();
    }
}
