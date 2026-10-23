# Third-party notice: GL Transitions

Nova Cut includes the transition shaders from **gl-transitions** 1.76.1
(https://github.com/gl-transitions/gl-transitions, https://gl-transitions.com), used under the MIT
licence below. Individual shaders carry their own author and licence line in their header comment;
those are kept intact in the bundled source and listed in the table.

## Package licence

MIT License

Copyright (c) 2017-present gl-transitions contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

Note: Individual transitions in the transitions/ directory may have their own
license specified in their file header comments. When no license is specified,
the transition is covered by this MIT license.

## Shaders under other licences

2 of the 125 bundled shaders are not MIT. Their notices are reproduced here as the
licences require, and the same text stays in the shader source.

### InvertedPageCurl  (BSD 3 Clause, Hewlett-Packard)

```
Copyright (c) 2010 Hewlett-Packard Development Company, L.P. All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

   * Redistributions of source code must retain the above copyright
     notice, this list of conditions and the following disclaimer.
   * Redistributions in binary form must reproduce the above
     copyright notice, this list of conditions and the following disclaimer
     in the documentation and/or other materials provided with the
     distribution.
   * Neither the name of Hewlett-Packard nor the names of its
     contributors may be used to endorse or promote products derived from
     this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
in vec2 texCoord;
```

### StereoViewer  (BSD 2 Clause, Ted Schundler)

The author's terms, from the shader's own header comment, are: "Free for use and modification by anyone with credit". Credit: **Ted Schundler**.

## Every bundled shader

| Shader | Author | Licence |
| --- | --- | --- |
| AdvancedMosaic | Sergey Kosarevsky | MIT |
| angular | Fernando Kuteken | MIT |
| BlockDissolve | nwoeanhinnogaehr | MIT |
| BookFlip | hong | MIT |
| Bounce | Adrian Purser | MIT |
| BowTieHorizontal | huynx | MIT |
| BowTieVertical | huynx | MIT |
| BowTieWithParameter | KMojek | MIT |
| Box | lql | MIT |
| burn | gre | MIT |
| burn0 | liubailin2020@gmail.com | MIT |
| ButterflyWaveScrawler | mandubian | MIT |
| cannabisleaf | @Flexi23 | MIT |
| chessboard | lql | MIT |
| circle | Fernando Kuteken | MIT |
| CircleCrop | fkuteken | MIT |
| circleopen | gre | MIT |
| colorphase | gre | MIT |
| ColourDistance | P-Seebauer | MIT |
| coord-from-in | haiyoucuv | MIT |
| CrazyParametricFun | mandubian | MIT |
| crosshatch | pthrasher | MIT |
| crosswarp | Eke Péter <peterekepeter@gmail.com> | MIT |
| CrossZoom | rectalogic | MIT |
| cube | gre | MIT |
| DefocusBlur | Sergey Kosarevsky | MIT |
| Directional | Gaëtan Renaudeau | MIT |
| directional-easing | Max Plotnikov | MIT |
| DirectionalScaled | Thibaut Foussard | MIT |
| directionalwarp | pschroen | MIT |
| directionalwipe | gre | MIT |
| displacement | Travis Fischer | MIT |
| dissolve | hjm1fb | MIT |
| DoomScreenTransition | Zeh Fernando | MIT |
| doorway | gre | MIT |
| Dreamy | mikolalysenko | MIT |
| DreamyZoom | Zeh Fernando | MIT |
| Drop_Zone_Flicker | bread | MIT |
| EdgeTransition | Woohyun Kim | MIT |
| fade | gre | MIT |
| fadecolor | gre | MIT |
| fadegrayscale | gre | MIT |
| FilmBurn | Anastasia Dunbar | MIT |
| flyeye | gre | MIT |
| Fold | nwoeanhinnogaehr | MIT |
| fragment | lbl | MIT |
| GlitchDisplace | Matt DesLauriers | MIT |
| GlitchMemories | Gunnar Roth | MIT |
| GridFlip | TimDonselaar | MIT |
| heart | gre | MIT |
| hexagonalize | Fernando Kuteken | MIT |
| HorizontalClose | martiniti | MIT |
| HorizontalOpen | martiniti | MIT |
| HSVfade | nwoeanhinnogaehr | MIT |
| InvertedPageCurl | Hewlett-Packard | BSD 3 Clause |
| kaleidoscope | nwoeanhinnogaehr | MIT |
| LeftRight | zhmy | MIT |
| LinearBlur | gre | MIT |
| luma | gre | MIT |
| luminance_melt | 0gust1 | MIT |
| morph | paniq | MIT |
| Mosaic | Xaychru | MIT |
| mosaic_transition | YueDev | MIT |
| multiply_blend | Fernando Kuteken | MIT |
| old_tv_lost_signal | mernking (gitlab.com/Godswork) | MIT |
| Overexposure | Ben Zhang | MIT |
| parametric_glitch | Yoni Maltsman @friendlyspinach | MIT |
| perlin | Rich Harris | MIT |
| pinwheel | Mr Speaker | MIT |
| pixelize | gre | MIT |
| polar_function | Fernando Kuteken | MIT |
| PolkaDotsCurtain | bobylito | MIT |
| powerKaleido | Boundless | MIT |
| PuzzleRight | JustKirillS | MIT |
| Radial | Xaychru | MIT |
| randomNoisex | towrabbit | MIT |
| randomsquares | gre | MIT |
| Rectangle | martiniti | MIT |
| RectangleCrop | martiniti | MIT |
| Revolve_Left | bread | MIT |
| ripple | gre | MIT |
| Rolls | Mark Craig | MIT |
| rotate_scale_fade | Fernando Kuteken | MIT |
| RotateScaleVanish | Mark Craig | MIT |
| rotateTransition | haiyoucuv | MIT |
| scale-in | haiyoucuv | MIT |
| SimpleFlip | nwoeanhinnogaehr | MIT |
| SimpleZoom | 0gust1 | MIT |
| SimpleZoomOut | Tianshuo | MIT |
| Slides | Mark Craig | MIT |
| splitSlideInHorizontal | OllyOllyOlly | MIT |
| splitSlideInOutHorizontal | OllyOllyOlly | MIT |
| splitSlideInOutVertical | OllyOllyOlly | MIT |
| splitSlideInVertical | OllyOllyOlly | MIT |
| splitSlideOutHorizontal | OllyOllyOlly | MIT |
| splitSlideOutVertical | OllyOllyOlly | MIT |
| squareswire | gre | MIT |
| squeeze | gre | MIT |
| StarWipe | Ben Lucas | MIT |
| static_wipe | Ben Lucas | MIT |
| StaticFade | Ben Lucas | MIT |
| StereoViewer | Ted Schundler | BSD 2 Clause |
| StripDatamoshGlitch | bread | MIT |
| swap | gre | MIT |
| Swirl | Sergey Kosarevsky | MIT |
| tangentMotionBlur | chenkai | MIT |
| TilesWave | numb3r23 | MIT |
| TopBottom | zhmy | MIT |
| TVStatic | Brandon Anzaldi | MIT |
| undulatingBurnOut | pthrasher | MIT |
| VerticalClose | martiniti | MIT |
| VerticalOpen | martiniti | MIT |
| WaterDrop | Paweł Płóciennik | MIT |
| wind | gre | MIT |
| windowblinds | Fabien Benetou | MIT |
| windowslice | gre | MIT |
| wipeDown | Jake Nelson | MIT |
| wipeLeft | Jake Nelson | MIT |
| wipeRight | Jake Nelson | MIT |
| wipeUp | Jake Nelson | MIT |
| x_axis_translation | lizhongjian | MIT |
| ZoomInCircles | dycm8009 | MIT |
| zoomInOut | OllyOllyOlly | MIT |
| ZoomLeftWipe | Handk | MIT |
| ZoomRigthWipe | Handk | MIT |

*Generated by scripts/build-gl-transitions.mjs. Do not edit by hand.*
