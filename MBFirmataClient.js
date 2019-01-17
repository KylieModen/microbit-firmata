/* Tasks:
  [ ] test and debug
  [ ] light sensor averaging
  [ ] split into two modules: MicrobitFirmataClient and MicroBitBoard
  [x] add touch pin configuration command
  [x] integrate with Brad's classes
  [x] event/update listener registration
  [x] event/update dispatching
  [x] auto-discover serial port for board
  [x] request firmata and firmware versions on connection open
  [x] finish display commands
  [x] keep track of sensor/pin state
*/

const serialport = require('serialport');
const EventEmitter = require('events');

class MicrobitFirmataClient {
	constructor() {
		this.addConstants();
		this.myPort = null;
		this.inbuf = new Uint8Array(1000);
		this.inbufCount = 0;

		this.firmataVersion = '';
		this.firmwareVersion = '';

		this.isScrolling = false;
		this.digitalInput = new Array(21).fill(false);
		this.analogChannel = new Array(16).fill(0);
		this.eventListeners = new Array();
		this.updateListeners = new Array();
	}

	addConstants() {
		// Add Firmata constants

		// Firamata Channel Messages

		this.STREAM_ANALOG				= 0xC0; // enable/disable streaming of an analog channel
		this.STREAM_DIGITAL				= 0xD0; // enable/disable tracking of a digital port
		this.ANALOG_UPDATE				= 0xE0; // analog channel update
		this.DIGITAL_UPDATE				= 0x90; // digital port update

		this.SYSEX_START				= 0xF0
		this.SET_PIN_MODE				= 0xF4; // set pin mode
		this.SET_DIGITAL_PIN			= 0xF5; // set pin value
		this.SYSEX_END					= 0xF7
		this.FIRMATA_VERSION			= 0xF9; // request/report Firmata protocol version
		this.SYSTEM_RESET				= 0xFF; // reset Firmata

		// Firamata Sysex Messages

		this.REPORT_FIRMWARE			= 0x79; // request/report firmware version and name
		this.SAMPLING_INTERVAL			= 0x7A; // set msecs between streamed analog samples

		// BBC micro:bit Sysex Messages (0x01-0x0F)

		this.MB_DISPLAY_CLEAR			= 0x01
		this.MB_DISPLAY_SHOW			= 0x02
		this.MB_DISPLAY_PLOT			= 0x03
		this.MB_SCROLL_STRING			= 0x04
		this.MB_SCROLL_INTEGER			= 0x05
		this.MB_SET_TOUCH_MODE			= 0x06
		// 0x07-0x0C reserved for additional micro:bit messages
		this.MB_REPORT_EVENT			= 0x0D
		this.MB_DEBUG_STRING			= 0x0E
		this.MB_EXTENDED_SYSEX			= 0x0F; // allow for 128 additional micro:bit messages

		// Firmata Pin Modes

		this.DIGITAL_INPUT				= 0x00
		this.DIGITAL_OUTPUT				= 0x01
		this.ANALOG_INPUT				= 0x02
		this.PWM						= 0x03
		this.INPUT_PULLUP				= 0x0B
		this.INPUT_PULLDOWN				= 0x0F; // micro:bit extension; not defined by Firmata
	}

	// Connecting/Disconnecting

	connect() {
		// Search serial port list for a connected micro:bit and, if found, open that port.

		serialport.list()
		.then((ports) => {
			for (var i = 0; i < ports.length; i++) {
				var p = ports[i];
				if ((p.vendorId == '0d28') && (p.productId == '0204')) {
					return p.comName;
				}
			}
			return null;
		})
		.then((portName) => {
			if (portName) {
				// Attempt to open the serial port on the given port name.
				// If this fails it will fail with an UnhandledPromiseRejectionWarning.
				console.log("Opening", portName);
				this.setSerialPort(new serialport(portName, { baudRate: 57600 }));
			} else {
				console.log("No micro:bit found; is your board plugged in?");
			}
		});
	}

	setSerialPort(port) {
		function dataReceived(data) {
			if ((this.inbufCount + data.length) < this.inbuf.length) {
				this.inbuf.set(data, this.inbufCount);
				this.inbufCount += data.length;
				this.processFirmatMessages();
			}
		}
		this.myPort = port;
		this.myPort.on('data', dataReceived.bind(this));
		this.getFirmataVersion();
		this.getFirmwareVersion();
	}

	disconnect() {
		if (this.myPort) {
			console.log("Closing", this.myPort.path);
			this.myPort.close();
			this.myPort = null;
		}
	}

	// Process Firmata Messages

	processFirmatMessages() {
		// Process and remove all complete Firmata messages in inbuf.

		if (!this.inbufCount) return; // nothing received
		var cmdStart = 0;
		while (true) {
			cmdStart = this.findCmdByte(cmdStart);
			if (cmdStart < 0) {; // no more messages
				this.inbufCount = 0;
				return;
			}
			var skipBytes = this.dispatchCommandAt(cmdStart);
			if (skipBytes < 0) {
				// command at cmdStart is incomplete: remove processed messages and exit
				if (0 == cmdStart) return; // cmd is already at start of inbuf
				var remainingBytes = this.inbufCount - cmdStart;
				this.inbuf.copyWithin(0, cmdStart, cmdStart + remainingBytes);
				this.inbufCount = remainingBytes;
				return;
			}
			cmdStart += skipBytes;
		}
	}

	findCmdByte(startIndex) {
		for (var i = startIndex; i < this.inbufCount; i++) {
			if (this.inbuf[i] & 0x80) return i;
		}
		return -1;
	}

	dispatchCommandAt(cmdStart) {
		// Attempt to process the command starting at the given index in inbuf.
		// If the command is incomplete, return -1.
		// Otherwise, process it and return the number of bytes in the entire command.

		var cmdByte = this.inbuf[cmdStart];
		var chanCmd = cmdByte & 0xF0;
		var argBytes = 0;
		var nextCmdIndex = this.findCmdByte(cmdStart + 1);
		if (nextCmdIndex < 0) {; // no next command; current command may not be complete
			if (this.SYSEX_START == cmdByte) return -1; // incomplete sysex
			argBytes = this.inbufCount - (cmdStart + 1);
			var argsNeeded = 2;
			if (0xFF == cmdByte) argsNeeded = 0;
			if ((0xC0 == chanCmd) || (0xD0 == chanCmd)) argsNeeded = 1;
			if (argBytes < argsNeeded) return -1;
		} else {
			argBytes = nextCmdIndex - (cmdStart + 1);
		}

		if (this.SYSEX_START == cmdByte) {; // system exclusive message: SYSEX_START ...data ... SYSEX_END
			if (this.SYSEX_END != this.inbuf[cmdStart + argBytes + 1]) {
				// last byte is not SYSEX_END; skip this message
				return argBytes + 1; // skip cmd + argBytes
			}
			this.dispatchSysexCommand(cmdStart + 1, argBytes - 1);
			return argBytes + 2; // skip cmd, arg bytes, and final SYSEX_END
		}

		var chan = cmdByte & 0xF;
		var arg1 = (argBytes > 0) ? this.inbuf[cmdStart + 1] : 0;
		var arg2 = (argBytes > 1) ? this.inbuf[cmdStart + 2] : 0;

		if (this.DIGITAL_UPDATE == chanCmd) this.receivedDigitalUpdate(chan, (arg1 | (arg2 << 7)));
		if (this.ANALOG_UPDATE == chanCmd) this.receivedAnalogUpdate(chan, (arg1 | (arg2 << 7)));
		if (this.FIRMATA_VERSION == cmdByte) this.receivedFirmataVersion(arg1, arg2);

		return argBytes + 1;
	}

	dispatchSysexCommand(sysexStart, argBytes) {
		var sysexCmd = this.inbuf[sysexStart];
		switch (sysexCmd) {
		case this.MB_REPORT_EVENT:
			this.receivedEvent(sysexStart, argBytes);
			break;
		case this.MB_DEBUG_STRING:
			var buf = this.inbuf.slice(sysexStart + 1, sysexStart + 1 + argBytes);
			console.log('DB: ' + new TextDecoder().decode(buf));
			break;
		case this.REPORT_FIRMWARE:
			this.receivedFirmwareVersion(sysexStart, argBytes);
			break;
		}
	}

	// Handling Messages from the micro:bit

	receivedFirmataVersion(major, minor) {
		this.firmataVersion = 'Firmata Protocol ' + major + '.' + minor;
	}

	receivedFirmwareVersion(sysexStart, argBytes) {
		var major = this.inbuf[sysexStart + 1];
		var minor = this.inbuf[sysexStart + 2];
		var utf8Bytes = new Array();
		for (var i = sysexStart + 3; i <= argBytes; i += 2) {
			utf8Bytes.push(this.inbuf[i] | (this.inbuf[i + 1] << 7));
		}
		var firmwareName = new TextDecoder().decode(Buffer.from(utf8Bytes));
		this.firmwareVersion = firmwareName + ' ' + major + '.' + minor;
	}

	receivedDigitalUpdate(chan, pinMask) {
		var pinNum = 8 * chan;
		for (var i = 0; i < 8; i++) {
			var isOn = ((pinMask & (1 << i)) != 0);
			if (pinNum < 21) this.digitalInput[pinNum] = isOn;
			pinNum++;
		}
	}

	receivedAnalogUpdate(chan, value) {
		if (value > 8191) value = value - 16384; // negative value (14-bits 2-completement)
console.log('A' + chan + ': ', value);
		this.analogChannel[chan] = value;
		for (var f of this.updateListeners) f.call(); // notify all update listeners
	}

	receivedEvent(sysexStart, argBytes) {
		var sourceID =
			(this.inbuf[sysexStart + 3] << 14) |
			(this.inbuf[sysexStart + 2] << 7) |
			this.inbuf[sysexStart + 1];
		var eventID =
			(this.inbuf[sysexStart + 6] << 14) |
			(this.inbuf[sysexStart + 5] << 7) |
			this.inbuf[sysexStart + 4];
console.log('receivedEvent', sourceID, eventID);
		for (var f of this.eventListeners) f.call(null, sourceID, eventID); // notify all event listeners
	}

	// Version Commands

	getFirmataVersion() {
		this.myPort.write([this.FIRMATA_VERSION, 0, 0]);
	}

	getFirmwareVersion() {
		this.myPort.write([this.SYSEX_START, this.REPORT_FIRMWARE, this.SYSEX_END]);
	}

	// Display Commands

	displayClear() {
		// Clear the display and stop any ongoing animation.

		this.myPort.write([this.SYSEX_START, this.MB_DISPLAY_CLEAR, this.SYSEX_END]);
	}

	displayShow(useGrayscale, pixels) {
		// Display the given 5x5 image on the display. If useGrayscale is true, pixel values
		// are brightness values in the range 0-255. Otherwise, a zero pixel value means off
		// and >0 means on. Pixels is an Array of 5-element Arrays.

		this.myPort.write([this.SYSEX_START, this.MB_DISPLAY_SHOW]);
		this.myPort.write([useGrayscale ? 1 : 0]);
		for (var y = 0; y < 5; y++) {
			for (var x = 0; x < 5; x++) {
				var pix = pixels[y][x];
				if (pix > 1) pix = pix / 2; // transmit as 7-bits
				this.myPort.write([pix & 0x7F]);
			}
		}
		this.myPort.write([this.SYSEX_END]);
	}

	displayPlot(x, y, brightness) {
		// Set the display pixel at x, y to the given brightness (0-255).

		this.myPort.write([this.SYSEX_START, this.MB_DISPLAY_PLOT,
			x, y, (brightness / 2) & 0x7F,
			this.SYSEX_END]);
	}

	scrollString(s, delay) {
		// Scroll the given string across the display with the given delay.
		// Omit the delay parameter to use the default scroll speed.
		// The maximum string length is 100 characters.

		if (null == delay) delay = 120;
		if (s.length > 100) s = s.slice(0, 100);
		var buf = new TextEncoder().encode(s);
		this.myPort.write([this.SYSEX_START, this.MB_SCROLL_STRING, delay]);
		for (var i = 0; i < buf.length; i++) {
			var b = buf[i];
			this.myPort.write([b & 0x7F, (b >> 7) & 0x7F]);
		}
		this.myPort.write([this.SYSEX_END]);
	}

	scrollNumber(n, delay) {
		// Scroll the given 32-bit integer value across the display with the given delay.
		// Omit the delay parameter to use the default scroll speed.
		// Note: 32-bit integer is transmitted as five 7-bit data bytes.

		if (null == delay) delay = 120;
		this.myPort.write([this.SYSEX_START, this.MB_SCROLL_INTEGER,
			delay,
			n & 0x7F, (n >> 7) & 0x7F, (n >> 14) & 0x7F, (n >> 21) & 0x7F, (n >> 28) & 0x7F,
			this.SYSEX_END]);
	}

	// Pin and Sensor Channel Commands

	trackDigitalPin(pinNum, optionalMode) {
		// Start tracking the given pin as a digital input.

		if ((pinNum < 0) || (pinNum > 20)) return;
		var port = pinNum >> 3;
		var mode = this.INPUT_PULLUP;
		if ((optionalMode == this.INPUT_PULLDOWN) || (optionalMode == this.INPUT_PULLUP)) {
			mode = optionalMode;
		}
		this.myPort.write([this.SET_PIN_MODE, pinNum, mode]);
		this.myPort.write([this.STREAM_DIGITAL | port, 1]);
	}

	stopTrackingDigitalPin(pinNum) {
		// Stop tracking the given pin as a digital input.

		if ((pinNum < 0) || (pinNum > 20)) return;
		var port = pinNum >> 3;
		this.myPort.write([this.STREAM_DIGITAL | port, 0]);
	}

	streamAnalogChannel(chan) {
		// Start streaming the given analog channel.

		if ((chan < 0) || (chan > 15)) return;
		this.myPort.write([this.STREAM_ANALOG | chan, 1]);
	}

	stopStreamingAnalogChannel(chan) {
		// Stop streaming the given analog channel.

		if ((chan < 0) || (chan > 15)) return;
		this.myPort.write([this.STREAM_ANALOG | chan, 0]);
	}

	setAnalogSamplingInterval(samplingMSecs) {
		// Set the number of milliseconds (1-16383) between analog channel updates.

		if ((samplingMSecs < 1) || (samplingMSecs > 16383)) return;
		this.myPort.write([this.SYSEX_START, this.SAMPLING_INTERVAL,
			samplingMSecs & 0x7F, (samplingMSecs >> 7) & 0x7F,
			this.SYSEX_END]);
	}

	setTouchMode(pinNum, touchModeOn) {
		// Turn touch mode on/off for a pin. Touch mode is only supported for pins 0-2).
		// When touch mode is on, the pin generates events as if it were a button.

		if ((pinNum < 0) || (pinNum > 2)) return;
		var mode = touchModeOn ? 1 : 0;
		this.myPort.write([this.SYSEX_START, this.MB_SET_TOUCH_MODE,
			pinNum, mode,
			this.SYSEX_END]);
	}

	// Event/Update Listeners

	addFirmataEventListener(eventListenerFunction) {
		// Add a listener function to handle micro:bit DAL events.
		// The function arguments are the sourceID and eventID (both numbers).

		this.eventListeners.push(eventListenerFunction);
	}

	addFirmataUpdateListener(updateListenerFunction) {
		// Add a listener function (with no arguments) called when sensor or pin updates arrive.

		this.updateListeners.push(updateListenerFunction);
	}

} // end class MicrobitFirmataClient


/**
 * Top-level controller for BBC micro:bit board.
 * Call constructor with an MBFirmataClient that has already been connected.
 *
 * @extends EventEmitter from NodeJS (available in browser code via webpack's node-libs-browser)
 *	@see https://nodejs.org/api/events.html#events_class_eventemitter
 *	@see https://github.com/webpack/node-libs-browser
 * @see http://usejsdoc.org if any annotations aren't clear
 */

class MicroBit extends EventEmitter {
	/**
	* @param {SerialPort|ChromeSerialPort} serialport
	*	@see https://serialport.io/docs/en/api-serialport
	*	@see https://github.com/code-dot-org/code-dot-org/blob/staging/apps/src/lib/kits/maker/CircuitPlaygroundBoard.js#L270-L290
	*/
	constructor(mbFirmataClient) {
		super();

		/** @member {LedMatrix} */
		this.ledMatrix = new LedMatrix(mbFirmataClient);

		/** @member {MBButton} */
		this.buttonA = new MBButton(mbFirmataClient, 1);

		/** @member {MBButton} */
		this.buttonB = new MBButton(mbFirmataClient, 2);

		/** @member {Accelerometer} */
		this.accelerometer = new Accelerometer(mbFirmataClient);

		/** @member {LightSensor} */
		this.lightSensor = new LightSensor(mbFirmataClient);

		/** @member {Array.<TouchPin>} */
		this.touchPins = new Array();
		for (var i = 0; i < 3; i++) this.touchPins.push(new TouchPin(mbFirmataClient, i));
	}

	/**
	* @event MicroBit#ready
	* Emits after construction if connection to the board is successful.
	*/

	/**
	* @event MicroBit#error
	* Emits when a connection attempt fails. (Include error details?)
	*/

	/**
	* @event MicroBit#disconnect
	* Emits when a board disconnect is detected.
	*/
}

class LedMatrix {
	constructor(mbFirmataClient) {
		this.mbFirmataClient = mbFirmataClient;
		this.mbFirmataClient.addFirmataEventListener(this.handleFirmataEvent.bind(this));
		this.isScrolling = false; // true while scrolling in progress
		this.leds = [
			[0, 0, 0, 0, 0],
			[0, 0, 0, 0, 0],
			[0, 0, 0, 0, 0],
			[0, 0, 0, 0, 0],
			[0, 0, 0, 0, 0]];
	}

	/**
	* Was not included in the spec but this seemed potentially useful to students.
	* @param {number} x (range 0..4)
	* @param {number} y (range 0..4)
	* @return {number} 0 or 1
	*/
	getLed(x, y) {
		if ((x < 0) || (x > 4) || (y < 0) || (y > 4)) return 0;
		return leds[y][x];
	}

	/**
	* Turn an individual LED on or off.
	* @param {number} x (range 0..4)
	* @param {number} y (range 0..4)
	* @param {number} brightness 0 or 1 for B&W or 0-255 for grayscale
	*/
	setLed(x, y, brightness) {
		if ((x < 0) || (x > 4) || (y < 0) || (y > 4)) return;
		var grayscaleMode = (brightness > 1);
		leds[y][x] = brightness;
		this.mbFirmataClient.displayShow(grayscaleMode, leds);
	}

	/**
	* Set the state of all display LEDs at once.
	* If any pixel value is > 1, use grayscale mode (brightness range 1..255).
	* @param {Array.<Array.<number>>} leds
	* @example
	*	microBit.ledMatrix.setDisplay([
	*		[0, 0, 1, 0, 0],
	*		[0, 1, 0, 0, 0],
	*		[0, 0, 1, 0, 0],
	*		[0, 0, 0, 1, 0],
	*		[0, 0, 1, 0, 0],
	*	]);
	*/
	setDisplay(leds) {
		var grayscaleMode = false;
		for (var y = 0; y < 5; y++) {
			for (var x = 0; x < 5; x++) {
				var pix = leds[y][x];
				if (pix > 1) grayscaleMode = true;
				this.leds[y][x] = pix;
			}
		}
		this.mbFirmataClient.displayShow(grayscaleMode, leds);
	}

	/**
	* Show a string on the display (animated marquee).
	* @param {string} text
	* @param {number} [interval] (default: 120)
	* @see https://makecode.microbit.org/reference/basic/show-string
	*/
	showString(text, interval) {
		if (null == interval) interval = 120;
		this.isScrolling = true;
		this.mbFirmataClient.scrollString(text, interval);
	}

	/**
	* Show an integer on the display (animated marquee).
	* @param {number} n
	* @param {number} [interval] (default: 120)
	*/
	showNumber(n, interval) {
		if (null == interval) interval = 120;
		this.isScrolling = true;
		this.mbFirmataClient.scrollNumber(n, interval);
	}

	handleFirmataEvent(sourceID, eventID) {
		const MICROBIT_ID_DISPLAY = 6;
		const MICROBIT_DISPLAY_EVT_ANIMATION_COMPLETE = 1;
		if ((sourceID == MICROBIT_ID_DISPLAY) &&
			(eventID == MICROBIT_DISPLAY_EVT_ANIMATION_COMPLETE)) {
				this.isScrolling = false;
		}
	}
}

class MBButton extends EventEmitter {
	constructor(mbFirmataClient, buttonID) {
		super();
		this.mbFirmataClient = mbFirmataClient;
		this.buttonID = buttonID;
		this.mbFirmataClient.addFirmataEventListener(this.handleFirmataEvent.bind(this));

		/**
		* Whether the button is currently down.
		* @member {boolean}
		* @readonly
		*/
		this.isPressed = false;
	}

	/**
	* @event Button#down
	*/

	/**
	* @event Button#up
	*/

	handleFirmataEvent(sourceID, eventID) {
		const MICROBIT_BUTTON_EVT_DOWN = 1;
		const MICROBIT_BUTTON_EVT_UP = 2;
		if (sourceID == this.buttonID) {
			if (MICROBIT_BUTTON_EVT_DOWN == eventID) {
				this.isPressed = true;
				// emit Button#down
			}
			if (MICROBIT_BUTTON_EVT_UP == eventID) {
				this.isPressed = false;
				// emit Button#up
			}
		}
	}
}

class Accelerometer extends EventEmitter {
	constructor(mbFirmataClient) {
		super();
		this.mbFirmataClient = mbFirmataClient;
		this.mbFirmataClient.addFirmataEventListener(this.handleFirmataEvent.bind(this));
		this.mbFirmataClient.addFirmataUpdateListener(this.handleFirmataUpdate.bind(this));

		/** @member {number} */
		this.x = 0;
		/** @member {number} */
		this.y = 0;
		/** @member {number} */
		this.z = 0;
	}

	/**
	* Begin streaming accelerometer data.
	*/
	enable() {
		this.mbFirmataClient.streamAnalogChannel(8);
		this.mbFirmataClient.streamAnalogChannel(9);
		this.mbFirmataClient.streamAnalogChannel(10);
	}

	/**
	* Stop streaming accelerometer data.
	*/
	disable() {
		this.mbFirmataClient.stopStreamingAnalogChannel(8);
		this.mbFirmataClient.stopStreamingAnalogChannel(9);
		this.mbFirmataClient.stopStreamingAnalogChannel(10);
	}

	/**
	* @event Accelerometer#change
	* @type {object}
	* @property {number} x
	* @property {number} y
	* @property {number} z
	*/

	/**
	* @event Accelerometer#shake
	*/

	/**
	* Accelerometer event received from micro:bit.
	*/
	handleFirmataEvent(sourceID, eventID) {
		const MICROBIT_ID_GESTURE = 27;
		if (sourceID == MICROBIT_ID_GESTURE) {
			// emit Accelerometer#shake or Accelerometer#freefall events
		}
	}

	/**
	* Accelerometer update received from micro:bit.
	*/
	handleFirmataUpdate() {
		this.x = this.mbFirmataClient.analogChannel[8];
		this.y = this.mbFirmataClient.analogChannel[9];
		this.z = this.mbFirmataClient.analogChannel[10];
		// emit Accelerometer#change event if necessary
	}
}

class LightSensor extends EventEmitter {
	constructor(mbFirmataClient) {
		super();
		this.mbFirmataClient = mbFirmataClient;
		this.mbFirmataClient.addFirmataUpdateListener(this.handleFirmataUpdate.bind(this));

		/** @member {array} the last N samples to be averaged */
		this.sampleValues = new Array(3).fill(0);

		/** @member {number} How much the value must change by to trigger a change event */
		this.threshold = 5;

		/** @member {number} How much the value must change by to trigger a change event */
		this.lastScaledValue = 0;
	}

	/**
	* Begin streaming light sensor data.
	*/
	enable() {
		this.mbFirmataClient.streamAnalogChannel(11);
	}

	/**
	* Stop streaming light sensor data.
	*/
	disable() {
		this.mbFirmataClient.stopStreamingAnalogChannel(11);
	}

	/**
	* Get the average value of the light sensor scaled to the given range.
	* @param {number} min minimum value of output range
	* @param {number} max minimum value of output range
	*	Open question: What's a reasonable maximum here?
	*	Open question: How do we communicate about maximum resolution / reasonable minimum?
	* @return {number} average value
	*/
	getScaledValue(min, max) {
		var total = 0;
		if (this.sampleValues.length == 0) this.sampleValues.push(0); // ensure not empty
		for (var i = 0; i < this.sampleValues.length; i++) {
			total += this.sampleValues[i];
		}
		var normalizedAverage = (total / this.sampleValues.length) / 255;
		return min + (normalizedAverage * (max - min));
	}

	/**
	* Sets the number of past light sensor values to include in the average.
	* @param {number} n
	*/
	setAverageCount(n) {
		if (n < 1) return; // must have at least one sample
		if (n > this.sampleValues.length) { // shrink if needed
			this.sampleValues = this.sampleValues.slice(0, n);
		}
		while (this.sampleValues.length < n) { // grow if needed
			this.sampleValues.unshift(0);
		}
	}

	/**
	* @event LightSensor#change
	* @type {number} scaled light sensor value
	*/

	/**
	* Lightsensor update received from micro:bit.
	*/
	handleFirmataUpdate() {
		this.sampleValues.push(this.mbFirmataClient.analogChannel[11]);
		if (this.sampleValues.length > 1) this.sampleValues.shift(); // remove oldest sample
	}
}

class TouchPin extends EventEmitter {
	constructor(mbFirmataClient, pinNum) {
		super();
		this.mbFirmataClient = mbFirmataClient;
		this.mbFirmataClient.addFirmataEventListener(this.handleFirmataEvent.bind(this));
		this.pinID = pinNum + 7; // pins 0-2 are touch event sources 7-9

		/** @member {boolean} Whether the touch pin is "down" */
		this.isPressed = false;
	}

	/**
	* Enable touch events on this pin.
	*/
	enable() {
		this.mbFirmataClient.setTouchMode(this.pinID - 7, true);
	}

	/**
	* Disable touch events on this pin.
	*/
	disable() {
		this.mbFirmataClient.setTouchMode(this.pinID - 7, false);
	}

	/**
	* @event TouchPin#down
	*/

	/**
	* @event TouchPin#up
	*/

	/**
	* Pin touch event received from micro:bit.
	*/
	handleFirmataEvent(sourceID, eventID) {
		const MICROBIT_BUTTON_EVT_DOWN = 1;
		const MICROBIT_BUTTON_EVT_UP = 2;
		if (sourceID == this.pinID) {
			if (MICROBIT_BUTTON_EVT_DOWN == eventID) {
				this.isPressed = true;
				// emit TouchPin#down
			}
			if (MICROBIT_BUTTON_EVT_UP == eventID) {
				this.isPressed = false;
				// emit TouchPin#up
			}
		}
	}

}

// for testing...
mb = new MicrobitFirmataClient();
mb.connect();
//mb.scrollString("MB Firmata 0.2", 80)

