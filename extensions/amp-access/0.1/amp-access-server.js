/**
 * Copyright 2016 The AMP HTML Authors. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS-IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {AccessClientAdapter} from './amp-access-client';
import {isExperimentOn} from '../../../src/experiments';
import {isProxyOrigin, removeFragment} from '../../../src/url';
import {dev} from '../../../src/log';
import {timer} from '../../../src/timer';
import {viewerFor} from '../../../src/viewer';
import {vsyncFor} from '../../../src/vsync';
import {xhrFor} from '../../../src/xhr';

/** @const {string} */
const TAG = 'amp-access-server';

/** @const {number} */
const AUTHORIZATION_TIMEOUT = 3000;

function convertStringToArrayBufferView(str) {
    var bytes = new Uint8Array(str.length);
    for (var i = 0; i < str.length; i++) {
        bytes[i] = str.charCodeAt(i);
    }
    return bytes;
}


/**
 * This class implements server-side authorization protocol. In this approach
 * only immediately visible sections are downloaded. For authorization, the
 * CDN calls the authorization endpoint directly and returns back to the
 * authorization response and the authorized content fragments, which are
 * merged into the document.
 *
 * The approximate diagram looks like this:
 *
 *        Initial GET
 *            ||
 *            ||   [Limited document: fragments requiring
 *            ||      authorization are exlcuded]
 *            ||
 *            \/
 *    Authorize request to CDN
 *            ||
 *            ||   [Authorization response]
 *            ||   [Authorized fragments]
 *            ||
 *            \/
 *    Merge authorized fragments
 *            ||
 *            ||
 *            \/
 *    Apply authorization response
 *
 * @implements {AccessTypeAdapterDef}
 */
export class AccessServerAdapter {

  /**
   * @param {!Window} win
   * @param {!JSONType} configJson
   * @param {!AccessTypeAdapterContextDef} context
   */
  constructor(win, configJson, context) {
    /** @const {!Window} */
    this.win = win;

    /** @const @private {!AccessTypeAdapterContextDef} */
    this.context_ = context;

    /** @private @const */
    this.clientAdapter_ = new AccessClientAdapter(win, configJson, context);

    /** @private @const {!Viewer} */
    this.viewer_ = viewerFor(win);

    /** @const @private {!Xhr} */
    this.xhr_ = xhrFor(win);

    /** @const @private {!Timer} */
    this.timer_ = timer;

    /** @const @private {!Vsync} */
    this.vsync_ = vsyncFor(win);

    /** @private @const {?SubtleCrypto} */
    this.subtle_ = null;

    /** @private @const {?Promise<!CryptoKey>} */
    this.keyPromise_ = null;

    const stateElement = this.win.document.querySelector(
        'meta[name="i-amp-access-state"]');

    /** @private @const {?string} */
    this.serverState_ = stateElement ?
        stateElement.getAttribute('content') : null;

    const isInExperiment = isExperimentOn(win, TAG);

    /** @private @const {boolean} */
    this.isProxyOrigin_ = isProxyOrigin(win.location) || isInExperiment;

    const serviceUrlOverride = isInExperiment ?
        this.viewer_.getParam('serverAccessService') : null;

    /** @private @const {string} */
    this.serviceUrl_ = serviceUrlOverride || removeFragment(win.location.href);
  }

  /** @override */
  getConfig() {
    return {
      'client': this.clientAdapter_.getConfig(),
      'proxy': this.isProxyOrigin_,
      'serverState': this.serverState_,
    };
  }

  /** @override */
  isAuthorizationEnabled() {
    return true;
  }

  /** @override */
  authorize() {
    dev.fine(TAG, 'Start authorization with ',
        this.isProxyOrigin_ ? 'proxy' : 'non-proxy',
        this.serverState_,
        this.clientAdapter_.getAuthorizationUrl());
    if (!this.isProxyOrigin_ || !this.serverState_) {
      dev.fine(TAG, 'Proceed via client protocol');
      return this.clientAdapter_.authorize();
    }

    dev.fine(TAG, 'Proceed via server protocol');

    const varsPromise = this.context_.collectUrlVars(
        this.clientAdapter_.getAuthorizationUrl(),
        /* useAuthData */ false);
    return varsPromise.then(vars => {
      const requestVars = {};
      for (const k in vars) {
        if (vars[k] != null) {
          requestVars[k] = String(vars[k]);
        }
      }
      const request = {
        'url': removeFragment(this.win.location.href),
        'state': this.serverState_,
        'vars': requestVars,
      };
      dev.fine(TAG, 'Authorization request: ', this.serviceUrl_, request);
      // Note that `application/x-www-form-urlencoded` is used to avoid
      // CORS preflight request.
      return this.timer_.timeoutPromise(
          AUTHORIZATION_TIMEOUT,
          this.xhr_.fetchDocument(this.serviceUrl_, {
            method: 'POST',
            body: 'request=' + encodeURIComponent(JSON.stringify(request)),
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
            },
          }));
    }).then(response => {
      dev.fine(TAG, 'Authorization response: ', response);
      const accessDataString = dev.assert(
          response.querySelector('script[id="amp-access-data"]'),
          'No authorization data available').textContent;
      const accessData = JSON.parse(accessDataString);
      dev.fine(TAG, '- access data: ', accessData);

      return this.replaceSections_(response).then(() => {
        return accessData;
      });
    });
  }

  /** @override */
  pingback() {
    return this.clientAdapter_.pingback();
  }

  /** @override */
  encodeReaderId(readerId) {
    dev.error(TAG, "bernie: in encodeReaderId(): ", readerId);
    return this.getSubtleWithKey_().then(key => {
      return this.subtle_.encrypt(key, convertStringToArrayBufferView(readerId))
          .then(data => {
            const encryptedReaderId = window.btoa(new Uint8Array(data));
            dev.error(TAG, "bernie: encryptedReaderId: ", encryptedReaderId);
            return encryptedReaderId;
          });
    });
  }

  /**
   * @return {!Promise<!CryptoKey>}
   * @private
   */
  getSubtleWithKey_() {
    if (!this.keyPromise_) {
      if (this.win.crypto) {
        this.subtle_ =
            this.win.crypto.subtle || this.win.crypto.webkitSubtle || null;
      }
      if (this.subtle_) {
        const testKey =
            'public_key: {"alg":"RSA-OAEP-256","e":"AQAB","ext":true,"key_ops":["encrypt"],"kty":"RSA","n":"nNfur__0p5qW_fGaTW4BNvtqx8SVxVfE3EkY78SS4AT68vjPq1kL82FMmt2Un3FPX_BAD22NB2LVziT3PaweWhgitbyv-JMjVymnza0LRETq2j-AlmETEpcHKtVSO70axZBzj8A0kIx_5d_ZSaScDYstVcWlSOfDh0575N-v4wWj5gyCSjIY0AJlmqToU2wIHrVdQwrvCj-2m4K86GRf_UF8NCt0RntN4CfRCqihoSIRKxHz12-CiCKhFwB3JyLcpMmMy_68h3jSYUP_YrVUXCYKnNNWmfLSDrP00juKBaQgwzPhpS_hkRkHgw9MxUit7JgxJH8JmCv5zWH1B8Un3w"}';
        this.keyPromise_ = this.subtle_.importKey(
            'jwk',
            testKey,
            { name: "RSA-OAEP", hash: {name: "SHA-256"}},
            /*extractable=*/true,
            ['encrypt']);
      } else {
        this.keyPromise_ = Promise.reject(new Error('No WebCrypto'));
      }
    }
    return this.keyPromise_;
  }

  /**
   * @param {!Document} doc
   * @return {!Promise}
   */
  replaceSections_(doc) {
    const sections = doc.querySelectorAll('[i-amp-access-id]');
    dev.fine(TAG, '- access sections: ', sections);
    return this.vsync_.mutatePromise(() => {
      for (let i = 0; i < sections.length; i++) {
        const section = sections[i];
        const sectionId = section.getAttribute('i-amp-access-id');
        const target = this.win.document.querySelector(
            '[i-amp-access-id="' + sectionId + '"]');
        if (!target) {
          dev.warn(TAG, 'Section not found: ', sectionId);
          continue;
        }
        target.parentElement.replaceChild(
            this.win.document.importNode(section, /* deep */ true),
            target);
      }
    });
  }
}
