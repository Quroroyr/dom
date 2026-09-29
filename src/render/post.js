import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

// Final grade: depth-of-field (cheap gather on the depth buffer), gentle
// vignette, milk haze lift, and fine grain. DOF is only on for macro shots.
// The quality tier sets the multisampling, bloom and how many taps the
// depth blur gathers (see quality.js).

const FinalShader = {
  uniforms: {
    tDiffuse: { value: null },
    tDepth: { value: null },
    uRes: { value: new THREE.Vector2(1, 1) },
    uTime: { value: 0 },
    uFocus: { value: 10 },   // metres
    uAperture: { value: 0 }, // 0 = off
    uTaps: { value: 28 },     // gather taps (quality tier; up to 28)
    uNear: { value: 0.1 },
    uFar: { value: 200 },
    uVignette: { value: 0.22 },
    uGrain: { value: 0.018 },
    uLift: { value: new THREE.Color('#f6f1ea') },
    uLiftAmt: { value: 0.0 },
  },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
  fragmentShader: /* glsl */ `
    #include <packing>
    varying vec2 vUv;
    uniform sampler2D tDiffuse, tDepth;
    uniform vec2 uRes; uniform float uTime, uFocus, uAperture, uNear, uFar, uVignette, uGrain, uLiftAmt, uTaps;
    uniform vec3 uLift;
    float linDepth(vec2 uv){ float d = texture2D(tDepth, uv).x; return perspectiveDepthToViewZ(d, uNear, uFar) * -1.0; }
    float coc(float z){ return clamp(abs(z - uFocus) / max(z, 0.001) * uAperture, 0.0, 1.0); }
    float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }
    void main(){
      vec4 col = texture2D(tDiffuse, vUv);
      // (a pixel in focus keeps its colour exactly: its gather is skipped)
      float c = uAperture > 0.0001 ? coc(linDepth(vUv)) : 0.0;
      if (c > 0.02) {
        vec3 acc = col.rgb; float w = 1.0;
        const int N = 28;
        float ga = 2.39996323;
        for (int i = 1; i < N; i++) {
          if (float(i) >= uTaps) break;
          float r = sqrt(float(i) / uTaps);
          float a = float(i) * ga;
          vec2 o = vec2(cos(a), sin(a)) * r * 16.0 / uRes;
          vec2 uv2 = vUv + o * c * 1.4;
          float c2 = coc(linDepth(uv2));
          float ww = smoothstep(0.0, 1.0, c2 + 0.15);
          acc += texture2D(tDiffuse, uv2).rgb * ww; w += ww;
        }
        col.rgb = mix(col.rgb, acc / w, smoothstep(0.02, 0.2, c));
      }
      col.rgb = mix(col.rgb, uLift, uLiftAmt);
      vec2 q = vUv - 0.5;
      q.x *= uRes.x / uRes.y;
      col.rgb *= 1.0 - uVignette * smoothstep(0.35, 1.05, length(q));
      col.rgb += (hash(vUv * uRes + fract(uTime) * 91.7) - 0.5) * uGrain;
      gl_FragColor = col;
    }`,
};

function sceneTarget(renderer, samples) {
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  const depthTex = new THREE.DepthTexture(size.x, size.y);
  depthTex.type = THREE.UnsignedIntType;
  return new THREE.WebGLRenderTarget(size.x, size.y, {
    type: THREE.HalfFloatType,
    depthTexture: depthTex,
    samples,
  });
}

export function createPost(renderer, scene, camera) {
  let samples = 4;
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  const composer = new EffectComposer(renderer, sceneTarget(renderer, samples));
  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);
  const bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.14, 0.55, 0.92);
  composer.addPass(bloom);
  const final = new ShaderPass(FinalShader);
  // RenderPass draws into readBuffer = renderTarget2 (a clone with its own depth texture)
  final.uniforms.tDepth.value = composer.renderTarget2.depthTexture;
  composer.addPass(final);
  composer.addPass(new OutputPass());

  // the depth blur at rest (the small aperture after the arrival) can be
  // left out on a light tier; the wide one of the arrival always plays
  let dofRest = true;
  // bloom resolution relative to the buffer (1: as three builds it)
  let bloomScale = 1;
  const size2 = new THREE.Vector2();
  const sizeBloom = () => {
    renderer.getDrawingBufferSize(size2);
    bloom.setSize(Math.max(2, Math.round(size2.x * bloomScale)), Math.max(2, Math.round(size2.y * bloomScale)));
  };

  return {
    composer, bloom, final,
    get samples() { return samples; },
    setQuality(p) {
      if (p.msaa !== samples) {
        // new targets with the other sample count (a sample count cannot
        // change on a live multisampled target)
        samples = p.msaa;
        composer.reset(sceneTarget(renderer, samples));
        final.uniforms.tDepth.value = composer.renderTarget2.depthTexture;
      }
      bloom.enabled = p.bloom > 0;
      if (p.bloom > 0 && p.bloom !== bloomScale) { bloomScale = p.bloom; sizeBloom(); }
      final.uniforms.uTaps.value = p.dofTaps;
      dofRest = p.dofRest;
    },
    setSize(w, h, dpr) {
      composer.setPixelRatio(dpr);
      composer.setSize(w, h);
      if (bloomScale !== 1) sizeBloom();
      final.uniforms.uRes.value.set(w * dpr, h * dpr);
    },
    render(time) {
      final.uniforms.uTime.value = time;
      final.uniforms.uNear.value = camera.near;
      final.uniforms.uFar.value = camera.far;
      const ap = final.uniforms.uAperture;
      const want = ap.value;
      if (!dofRest && want < 0.2) ap.value = 0;
      composer.render();
      ap.value = want;
    },
  };
}
