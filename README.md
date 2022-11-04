# This package is deprecated. Use [esptool-js](https://github.com/espressif/esptool-js/) instead.

# ESP Web Flasher

JavaScript package to install firmware on ESP devices via the browser using WebSerial.

_This project is a collaboration between [Adafruit](https://www.adafruit.com/) and [Nabu Casa](https://www.nabucasa.com/)._

## Used by

- [Adafruit WipperSnapper](https://learn.adafruit.com/quickstart-adafruit-io-wippersnapper)
- [ESP Web Tools](https://github.com/esphome/esp-web-tools), the one click button to install your ESP devices via the browser.

## Local development

- Clone this repository.
- Install dependencies with `npm`
- Run `script/develop`
- Open http://localhost:5004/

## Origin

This project was originally written by [Melissa LeBlanc-Williams](https://github.com/makermelissa). [Nabu Casa](https://www.nabucasa.com) ported the code over to TypeScript and in March 2022 took over maintenance from Adafruit. In July 2022, the Nabucasa stopped maintaining the project in favor of an official, but very early release of Espressif's [esptool-js](https://github.com/espressif/esptool-js/). Due to the instability of the tool, Adafruit updated their fork with Nabucasa's changes and took over maintenance once again.


A live copy of the tool is hosted here: https://adafruit.github.io/Adafruit_WebSerial_ESPTool/