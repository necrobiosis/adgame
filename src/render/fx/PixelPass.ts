import * as THREE from 'three';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

/**
 * 像素化 + 调色板量化。
 *
 * 做法是**采样时把 uv 吸附到一张粗网格上**，而不是真的把整条渲染链降分辨率。
 * 后者要给 bloom / GTAO / SMAA 每一趟都换尺寸，收益却一样——最终画面上一个
 * "像素块"里的所有屏幕像素读的是同一个采样点，看起来就是硬边的像素画。
 *
 * 横向块数固定成 PIXEL_COLS：这样手机和桌面看到的像素颗粒一样粗，
 * 不会出现"屏幕越大画面越细腻"这种破坏风格的事。
 *
 * 颜色再按 uLevels 分档。这一步是"像素风"和"只是糊了"的分界线：真正的像素画
 * 用的是有限的色板，连续渐变会立刻把这个味道洗掉。放在 OutputPass 之后做，
 * 所以量化的是最终 sRGB 颜色，档位是均匀的。
 */
export const PIXEL_COLS = 208;

export function createPixelPass(): ShaderPass {
  return new ShaderPass({
    uniforms: {
      tDiffuse: { value: null },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uLevels: { value: 22 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D tDiffuse;
      uniform vec2 uResolution;
      uniform float uLevels;
      varying vec2 vUv;

      void main() {
        // 一个像素块在屏幕上有多大，由横向块数决定；纵向用同样的边长，
        // 免得竖屏被拉成长方形的"像素"
        float block = max(1.0, uResolution.x / ${PIXEL_COLS.toFixed(1)});
        vec2 grid = uResolution / block;
        vec2 uv = (floor(vUv * grid) + 0.5) / grid;
        vec4 c = texture2D(tDiffuse, uv);
        c.rgb = floor(c.rgb * uLevels + 0.5) / uLevels;
        gl_FragColor = c;
      }
    `,
  });
}
