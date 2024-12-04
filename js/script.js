let espStub;
import { ESPLoader, Transport } from "https://unpkg.com/esptool-js/bundle.js";

const baudRates = [921600, 115200, 230400, 460800];

const maxLogLength = 100;
const log = document.getElementById("log");
const butConnect = document.getElementById("butConnect");
const baudRate = document.getElementById("baudRate");
const butClear = document.getElementById("butClear");
const butErase = document.getElementById("butErase");
const butProgram = document.getElementById("butProgram");
const autoscroll = document.getElementById("autoscroll");
const lightSS = document.getElementById("light");
const darkSS = document.getElementById("dark");
const darkMode = document.getElementById("darkmode");
const firmware = document.querySelectorAll(".upload .firmware input");
const progress = document.querySelectorAll(".upload .progress-bar");
const offsets = document.querySelectorAll(".upload .offset");
const appDiv = document.getElementById("app");
const noReset = document.getElementById("noReset");

let device = null;
let transport = null;
let esploader = null;
let chip = null;
const serialLib = !navigator.serial && navigator.usb ? serial : navigator.serial;

document.addEventListener("DOMContentLoaded", () => {
    butConnect.addEventListener("click", () => {
        clickConnect().catch(async (e) => {
            console.error(e);
            errorMsg(e.message || e);
            if (espStub) {
            await espStub.disconnect();
            }
            toggleUIConnected(false);
        });
    });
    butClear.addEventListener("click", clickClear);
    butErase.addEventListener("click", clickErase);
    butProgram.addEventListener("click", clickProgram);
    for (let i = 0; i < firmware.length; i++) {
        firmware[i].addEventListener("change", checkFirmware);
    }
    for (let i = 0; i < offsets.length; i++) {
        offsets[i].addEventListener("change", checkProgrammable);
    }
    autoscroll.addEventListener("click", clickAutoscroll);
    baudRate.addEventListener("change", changeBaudRate);
    darkMode.addEventListener("click", clickDarkMode);
    noReset.addEventListener("change", () => {
        console.log("Checkbox changed:", noReset.checked); // Log checkbox state changes
    });

    window.addEventListener("error", function (event) {
        console.log("Got an uncaught error: ", event.error);
    });
    if ("serial" in navigator) {
        const notSupported = document.getElementById("notSupported");
        notSupported.classList.add("hidden");
    }

    initBaudRate();
    loadAllSettings();
    updateTheme();
    logMsg("ESP Web Flasher loaded.");
});

function initBaudRate() {
    for (let rate of baudRates) {
        var option = document.createElement("option");
        option.text = rate + " Baud";
        option.value = rate;
        baudRate.add(option);
    }
}

function pruneLog() {
    // Remove old log content
    if (log.textContent.split("\n").length > maxLogLength + 1) {
        let logLines = log.innerHTML.replace(/(\n)/gm, "").split("<br>");
        log.innerHTML = logLines.splice(-maxLogLength).join("<br>\n");
    }

    if (autoscroll.checked) {
        log.scrollTop = log.scrollHeight;
    }
}

function writeLog(text) {
    log.innerHTML += text;
    pruneLog();
}

function logMsg(text) {
    writeLog(text + "<br>");
}

const espLoaderTerminal = {
    clean() {
        log.innerHTML = "";
    },
    writeLine(data) {
        logMsg(data + "<br />");
    },
    write(data) {
        writeLog(data);
    },
};

function debugMsg(...args) {
    function getStackTrace() {
        let stack = new Error().stack;
        //console.log(stack);
        stack = stack.split("\n").map((v) => v.trim());
        stack.shift();
        stack.shift();

        let trace = [];
        for (let line of stack) {
            line = line.replace("at ", "");
            trace.push({
                func: line.substr(0, line.indexOf("(") - 1),
                pos: line.substring(line.indexOf(".js:") + 4, line.lastIndexOf(":")),
            });
        }

        return trace;
    }

    let stack = getStackTrace();
    stack.shift();
    let top = stack.shift();
    let prefix = '<span class="debug-function">[' + top.func + ":" + top.pos + "]</span> ";
    for (let arg of args) {
        if (arg === undefined) {
            logMsg(prefix + "undefined");
        } else if (arg === null) {
            logMsg(prefix + "null");
        } else if (typeof arg == "string") {
            logMsg(prefix + arg);
        } else if (typeof arg == "number") {
            logMsg(prefix + arg);
        } else if (typeof arg == "boolean") {
            logMsg(prefix + (arg ? "true" : "false"));
        } else if (Array.isArray(arg)) {
            logMsg(prefix + "[" + arg.map((value) => toHex(value)).join(", ") + "]");
        } else if (typeof arg == "object" && arg instanceof Uint8Array) {
            logMsg(
                prefix +
                "[" +
                Array.from(arg)
                    .map((value) => toHex(value))
                    .join(", ") +
                "]"
            );
        } else {
            logMsg(prefix + "Unhandled type of argument:" + typeof arg);
            console.log(arg);
        }
        prefix = ""; // Only show for first argument
    }
}

function errorMsg(text) {
    logMsg('<span class="error-message">Error:</span> ' + text);
    console.error(text);
}

/**
 * @name updateTheme
 * Sets the theme to  Adafruit (dark) mode. Can be refactored later for more themes
 */
function updateTheme() {
    // Disable all themes
    document
        .querySelectorAll("link[rel=stylesheet].alternate")
        .forEach((styleSheet) => {
        enableStyleSheet(styleSheet, false);
        });

    if (darkMode.checked) {
        enableStyleSheet(darkSS, true);
    } else {
        enableStyleSheet(lightSS, true);
    }
}

function enableStyleSheet(node, enabled) {
    node.disabled = !enabled;
}

function formatMacAddr(macAddr) {
    return macAddr
        .map((value) => value.toString(16).toUpperCase().padStart(2, "0"))
        .join(":");
}

/**
 * @name clickConnect
 * Click handler for the connect/disconnect button.
 */
async function clickConnect() {
    if (transport !== null) {
        await transport.disconnect();
        await transport.waitForUnlock(1500);
        toggleUIConnected(false);
        transport = null;
        device = null;
        chip = null;
        return;
    }

    if (device === null) {
        device = await serialLib.requestPort({});
        transport = new Transport(device, true);
    }

    try {
        const loaderOptions = {
            transport: transport,
            baudrate: parseInt(baudRate.value),
            terminal: espLoaderTerminal,
            debugLogging: false,
        };

        esploader = new ESPLoader(loaderOptions);

        chip = await esploader.main();

        // Temporarily broken
        // await esploader.flashId();
        toggleUIConnected(true);
        toggleUIToolbar(true);
    } catch (e) {
        console.error(e);
        errorMsg(e.message);
    }
    console.log("Settings done for :" + chip);
}

/**
 * @name changeBaudRate
 * Change handler for the Baud Rate selector.
 */
async function changeBaudRate() {
    saveSetting("baudrate", baudRate.value);
    if (espStub) {
        let baud = parseInt(baudRate.value);
        if (baudRates.includes(baud)) {
            await espStub.setBaudrate(baud);
        }
    }
}

/**
 * @name clickAutoscroll
 * Change handler for the Autoscroll checkbox.
 */
async function clickAutoscroll() {
    saveSetting("autoscroll", autoscroll.checked);
}

/**
 * @name clickDarkMode
 * Change handler for the Dark Mode checkbox.
 */
async function clickDarkMode() {
    updateTheme();
    saveSetting("darkmode", darkMode.checked);
}

/**
 * @name clickNoReset
 * Change handler for ESP32 co-processor boards
 */
async function clickNoReset() {
    console.log("Checkbox state:", noReset.checked); // Debugging output
    saveSetting("noReset", noReset.checked);
}

/**
 * @name clickErase
 * Click handler for the erase button.
 */
async function clickErase() {
    if (
        window.confirm("This will erase the entire flash. Click OK to continue.")
    ) {
        baudRate.disabled = true;
        butErase.disabled = true;
        butProgram.disabled = true;
        try {
            logMsg("Erasing flash memory. Please wait...");
            let stamp = Date.now();
            await espStub.eraseFlash();
            logMsg("Finished. Took " + (Date.now() - stamp) + "ms to erase.");
        } catch (e) {
            errorMsg(e);
        } finally {
            butErase.disabled = false;
            baudRate.disabled = false;
            butProgram.disabled = getValidFiles().length == 0;
        }
    }
}

/**
 * @name clickProgram
 * Click handler for the program button.
 */
async function clickProgram() {
    const readUploadedFileAsArrayBuffer = (inputFile) => {
        const reader = new FileReader();

        return new Promise((resolve, reject) => {
            reader.onerror = () => {
                reader.abort();
                reject(new DOMException("Problem parsing input file."));
            };

            reader.onload = () => {
                resolve(reader.result);
            };
            reader.readAsArrayBuffer(inputFile);
        });
    };

    baudRate.disabled = true;
    butErase.disabled = true;
    butProgram.disabled = true;
    for (let i = 0; i < 4; i++) {
        firmware[i].disabled = true;
        offsets[i].disabled = true;
    }
    for (let file of getValidFiles()) {
        progress[file].classList.remove("hidden");
        let binfile = firmware[file].files[0];
        let contents = await readUploadedFileAsArrayBuffer(binfile);
        try {
            let offset = parseInt(offsets[file].value, 16);
            const progressBar = progress[file].querySelector("div");
            await espStub.flashData(
                contents,
                (bytesWritten, totalBytes) => {
                    progressBar.style.width = Math.floor((bytesWritten / totalBytes) * 100) + "%";
                },
                offset
            );
            await sleep(100);
        } catch (e) {
            errorMsg(e);
        }
    }
    for (let i = 0; i < 4; i++) {
        firmware[i].disabled = false;
        offsets[i].disabled = false;
        progress[i].classList.add("hidden");
        progress[i].querySelector("div").style.width = "0";
    }
    butErase.disabled = false;
    baudRate.disabled = false;
    butProgram.disabled = getValidFiles().length == 0;
    logMsg("To run the new firmware, please reset your device.");
}

function getValidFiles() {
    // Get a list of file and offsets
    // This will be used to check if we have valid stuff
    // and will also return a list of files to program
    let validFiles = [];
    let offsetVals = [];
    for (let i = 0; i < 4; i++) {
        let offs = parseInt(offsets[i].value, 16);
        if (firmware[i].files.length > 0 && !offsetVals.includes(offs)) {
            validFiles.push(i);
            offsetVals.push(offs);
        }
    }
    return validFiles;
}

/**
 * @name checkProgrammable
 * Check if the conditions to program the device are sufficient
 */
async function checkProgrammable() {
    butProgram.disabled = getValidFiles().length == 0;
}

/**
 * @name checkFirmware
 * Handler for firmware upload changes
 */
async function checkFirmware(event) {
    let filename = event.target.value.split("\\").pop();
    let label = event.target.parentNode.querySelector("span");
    let icon = event.target.parentNode.querySelector("svg");
    if (filename != "") {
        if (filename.length > 17) {
            label.innerHTML = filename.substring(0, 14) + "&hellip;";
        } else {
            label.innerHTML = filename;
        }
        icon.classList.add("hidden");
    } else {
        label.innerHTML = "Choose a file&hellip;";
        icon.classList.remove("hidden");
    }

    await checkProgrammable();
}

/**
 * @name clickClear
 * Click handler for the clear button.
 */
async function clickClear() {
    // reset();     Reset function wasnt declared.
    log.innerHTML = "";
}

function convertJSON(chunk) {
    try {
        let jsonObj = JSON.parse(chunk);
        return jsonObj;
    } catch (e) {
        return chunk;
    }
}

function toggleUIToolbar(show) {
    for (let i = 0; i < 4; i++) {
        progress[i].classList.add("hidden");
        progress[i].querySelector("div").style.width = "0";
    }
    if (show) {
        appDiv.classList.add("connected");
    } else {
        appDiv.classList.remove("connected");
    }
    butErase.disabled = !show;
}

function toggleUIConnected(connected) {
    let lbl = "Connect";
    if (connected) {
        lbl = "Disconnect";
    } else {
        toggleUIToolbar(false);
    }
    butConnect.textContent = lbl;
}

function loadAllSettings() {
    // Load all saved settings or defaults
    autoscroll.checked = loadSetting("autoscroll", true);
    baudRate.value = loadSetting("baudrate", 115200);
    darkMode.checked = loadSetting("darkmode", false);
    noReset.checked = loadSetting("noReset", false);
}

function loadSetting(setting, defaultValue) {
    let value = JSON.parse(window.localStorage.getItem(setting));
    if (value == null) {
        return defaultValue;
    }

    return value;
}

function saveSetting(setting, value) {
    window.localStorage.setItem(setting, JSON.stringify(value));
}

function ucWords(text) {
    return text
        .replace("_", " ")
        .toLowerCase()
        .replace(/(?<= )[^\s]|^./g, (a) => a.toUpperCase());
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
