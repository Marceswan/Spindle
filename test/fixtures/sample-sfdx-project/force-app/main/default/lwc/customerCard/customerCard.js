import { LightningElement, api, wire } from 'lwc';
import { getRecord } from 'lightning/uiRecordApi';
import EMAIL_FIELD from '@salesforce/schema/Customer__c.Email__c';
import TIER_FIELD from '@salesforce/schema/Customer__c.Tier__c';
import CUSTOMER_OBJECT from '@salesforce/schema/Customer__c';
import LABEL_GREETING from '@salesforce/label/c.Greeting';
import cleanupApex from '@salesforce/apex/AccountService.cleanup';

export default class CustomerCard extends LightningElement {
    @api recordId;
    customer;
    greeting = LABEL_GREETING;

    @wire(getRecord, { recordId: '$recordId', fields: [EMAIL_FIELD, TIER_FIELD] })
    wiredCustomer({ data }) {
        this.customer = data;
    }

    async handleCleanup() {
        await cleanupApex();
    }

    get objectName() {
        return CUSTOMER_OBJECT.objectApiName;
    }
}
