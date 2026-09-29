import * as THREE from 'three';
import { HorizontalBlurShader } from 'three/examples/jsm/shaders/HorizontalBlurShader.js';
import { VerticalBlurShader } from 'three/examples/jsm/shaders/VerticalBlurShader.js';

// ---------------------------------------------------------------------------
// Atmosphere: palette of the air. Everything that is "weather" lives here so a
// palette change relights the whole frame (ERA Residence lesson).

export function createAtmosphere() {
  return {
    zenith: new THREE.Color('#b5c2d3'),
    horizon: new THREE.Color('#ece4da'),
    ground: new THREE.Color('#e3dbd0'),
    sunColor: new THREE.Color('#fff0dd'),
    sunIntensity: 4.2,
    glow: new THREE.Color('#ffb870'),
    // stylised cloud light: warm lit side, cool lilac shade, silver lining
    cloudLit: new THREE.Color('#fff1e0'),
    cloudShadow: new THREE.Color('#bdbedb'),
    cloudRim: new THREE.Color('#fffaf2'),
    haze: 0.0,
  };
}

// ---------------------------------------------------------------------------
// Studio environment (PMREM). Rebuilt when the atmosphere changes a lot.

export function buildEnvironment(renderer, atm) {
  const scene = new THREE.Scene();
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(50, 48, 24),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      uniforms: {
        zenith: { value: atm.zenith.clone().multiplyScalar(0.95) },
        horizon: { value: atm.horizon.clone().multiplyScalar(1.05) },
        ground: { value: atm.ground.clone().multiplyScalar(0.75) },
      },
      vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
      fragmentShader: `varying vec3 vP; uniform vec3 zenith, horizon, ground;
        void main(){ float y = vP.y; vec3 c = y > 0.0 ? mix(horizon, zenith, pow(y, 0.6)) : mix(horizon, ground, pow(-y, 0.35));
        gl_FragColor = vec4(c, 1.0); }`,
    })
  );
  scene.add(dome);
  const panel = (w, h, color, intensity, pos) => {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(intensity), side: THREE.DoubleSide })
    );
    m.position.copy(pos);
    m.lookAt(0, 2, 0);
    scene.add(m);
  };
  // warm key softbox upper-left-front, cool fill right, thin rim behind, warm floor bounce
  panel(26, 18, atm.sunColor, 3.2, new THREE.Vector3(-22, 26, 18));
  panel(18, 22, '#dfe9f5', 1.25, new THREE.Vector3(30, 10, 8));
  panel(34, 5, '#ffffff', 2.2, new THREE.Vector3(6, 16, -32));
  panel(40, 40, atm.ground, 0.55, new THREE.Vector3(0, -8, 0));
  // two narrow strips: crisp, readable highlights on glaze and pearl
  panel(2.2, 26, '#ffffff', 7.0, new THREE.Vector3(-14, 18, 26));
  panel(1.4, 18, '#fff4e8', 5.0, new THREE.Vector3(24, 14, 20));

  const pmrem = new THREE.PMREMGenerator(renderer);
  const rt = pmrem.fromScene(scene, 0.035);
  pmrem.dispose();
  scene.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
  return rt;
}

// ---------------------------------------------------------------------------
// Background: full-screen cyclorama. View-direction gradient + sun bloom.

export function createBackground(atm) {
  const mat = new THREE.ShaderMaterial({
    depthWrite: false,
    depthTest: false,
    uniforms: {
      uInvProj: { value: new THREE.Matrix4() },
      uCamWorld: { value: new THREE.Matrix4() },
      uZenith: { value: atm.zenith },
      uHorizon: { value: atm.horizon },
      uGround: { value: atm.ground },
      uSunDir: { value: new THREE.Vector3(-0.5, 0.6, 0.4).normalize() },
      uSunCol: { value: atm.sunColor },
      uTime: { value: 0 },
      uDim: { value: 1 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vNdc;
      void main(){ vNdc = position.xy; gl_Position = vec4(position.xy, 0.9999, 1.0); }`,
    fragmentShader: /* glsl */ `
      varying vec2 vNdc;
      uniform mat4 uInvProj, uCamWorld;
      uniform vec3 uZenith, uHorizon, uGround, uSunDir, uSunCol;
      uniform float uDim;
      float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }
      void main(){
        vec4 v = uInvProj * vec4(vNdc, 1.0, 1.0);
        vec3 dir = normalize((uCamWorld * vec4(normalize(v.xyz / v.w), 0.0)).xyz);
        float y = dir.y;
        vec3 sky = mix(uHorizon, uZenith, smoothstep(0.0, 0.75, pow(max(y, 0.0), 0.8)));
        vec3 col = y > 0.0 ? sky : mix(uHorizon, uGround, smoothstep(0.0, 0.25, -y));
        // haze band hugging the horizon
        col = mix(col, uHorizon * 1.02, exp(-abs(y) * 9.0) * 0.55);
        // broad sun bloom, very soft
        float s = max(dot(dir, uSunDir), 0.0);
        col += uSunCol * (pow(s, 6.0) * 0.08 + pow(s, 40.0) * 0.06);
        col *= uDim;
        col += (hash(gl_FragCoord.xy) - 0.5) / 255.0;
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  mesh.update = (camera) => {
    mat.uniforms.uInvProj.value.copy(camera.projectionMatrixInverse);
    mat.uniforms.uCamWorld.value.copy(camera.matrixWorld);
  };
  return mesh;
}

// ---------------------------------------------------------------------------
// Contact shadow: orthographic depth-ish render from under the house, blurred.

export function createContactShadow(renderer, { size = 16, res = 512, height = 7, blur = 2.6 } = {}) {
  const rtA = new THREE.WebGLRenderTarget(res, res, { type: THREE.HalfFloatType });
  const rtB = new THREE.WebGLRenderTarget(res, res, { type: THREE.HalfFloatType });
  const cam = new THREE.OrthographicCamera(-size / 2, size / 2, size / 2, -size / 2, 0, height);
  cam.position.set(0.2, 0, 0);
  cam.rotation.x = Math.PI / 2; // look up
  const depthMat = new THREE.ShaderMaterial({
    uniforms: { uHeight: { value: height } },
    vertexShader: `varying float vY; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vY = w.y; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `varying float vY; uniform float uHeight; void main(){ float a = pow(1.0 - clamp(vY / uHeight, 0.0, 1.0), 2.4); gl_FragColor = vec4(vec3(0.0), a); }`,
    side: THREE.DoubleSide,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
  const qScene = new THREE.Scene();
  qScene.add(quad);
  const qCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const hBlur = new THREE.ShaderMaterial(HorizontalBlurShader);
  const vBlur = new THREE.ShaderMaterial(VerticalBlurShader);
  hBlur.depthTest = vBlur.depthTest = false;

  function render(scene, layerMask) {
    const prevOverride = scene.overrideMaterial;
    const prevBg = scene.background;
    const prevTarget = renderer.getRenderTarget();
    const prevClear = renderer.getClearAlpha();
    scene.overrideMaterial = depthMat;
    scene.background = null;
    renderer.setRenderTarget(rtA);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    cam.layers.mask = layerMask;
    renderer.render(scene, cam);
    scene.overrideMaterial = prevOverride;
    scene.background = prevBg;
    const pass = (amount) => {
      quad.material = hBlur;
      hBlur.uniforms.tDiffuse.value = rtA.texture;
      hBlur.uniforms.h.value = amount / res;
      renderer.setRenderTarget(rtB);
      renderer.render(qScene, qCam);
      quad.material = vBlur;
      vBlur.uniforms.tDiffuse.value = rtB.texture;
      vBlur.uniforms.v.value = amount / res;
      renderer.setRenderTarget(rtA);
      renderer.render(qScene, qCam);
    };
    pass(blur);
    pass(blur * 0.45);
    renderer.setRenderTarget(prevTarget);
    renderer.setClearAlpha(prevClear);
  }
  return { texture: rtA.texture, render, size, center: new THREE.Vector2(cam.position.x, cam.position.z) };
}

// ---------------------------------------------------------------------------
// Floor: dissolves into the horizon; carries contact shadow + a soft sun shadow.

export function createFloor(atm, contact) {
  const mat = new THREE.ShaderMaterial({
    transparent: false,
    uniforms: {
      uGround: { value: atm.ground },
      uHorizon: { value: atm.horizon },
      uContact: { value: contact.texture },
      uContactSize: { value: contact.size },
      uContactCenter: { value: contact.center },
      uContactStrength: { value: 0.62 },
      uGlowCol: { value: atm.glow },
      uGlowPos: { value: new THREE.Vector3(0.9, 0, 0) },
      uGlow: { value: 0.0 },
      uDim: { value: 1 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vW; varying vec4 vClip;
      void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: /* glsl */ `
      varying vec3 vW;
      uniform vec3 uGround, uHorizon, uGlowCol, uGlowPos;
      uniform sampler2D uContact; uniform float uContactSize, uContactStrength, uGlow, uDim;
      uniform vec2 uContactCenter;
      float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }
      void main(){
        float r = length(vW.xz);
        vec3 col = mix(uGround, uHorizon, smoothstep(6.0, 34.0, r));
        vec2 uv = (vW.xz - uContactCenter) / uContactSize + 0.5;
        float sh = 0.0;
        if (uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0) sh = texture2D(uContact, uv).a;
        col *= 1.0 - sh * uContactStrength;
        col *= uDim;
        // warm light pooling from the glowing arch
        float g = exp(-distance(vW.xz, uGlowPos.xz) * 0.9) * uGlow;
        col += uGlowCol * g * 0.25;
        col += (hash(gl_FragCoord.xy) - 0.5) / 255.0;
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.CircleGeometry(80, 96), mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.renderOrder = -900;
  return mesh;
}

// receives the sun's soft shadow (VSM) on top of the floor
export function createShadowCatcher() {
  const mat = new THREE.ShadowMaterial({ opacity: 0.16, color: new THREE.Color('#6d6272') });
  const mesh = new THREE.Mesh(new THREE.CircleGeometry(24, 64), mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.002;
  mesh.receiveShadow = true;
  mesh.renderOrder = -800;
  return mesh;
}
